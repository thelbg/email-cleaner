import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { EmailMetadata, EmailGroup, CategorizationResult } from './types.js';

const GroupSchema = z.object({
  name: z.string(),
  description: z.string(),
  emailIds: z.array(z.string()),
});

const CategorizationSchema = z.object({
  groups: z.array(GroupSchema),
});

const SYSTEM_PROMPT = `You are an email organization assistant. Your job is to identify groups of obviously disposable emails that a user can safely archive in bulk.

Rules:
- Group by SPECIFIC sender + pattern, not broad categories
  - Good: "New York Times Morning Briefing (47 emails)", "ParkWhiz parking receipts (23 emails)", "GitHub Actions build notifications (31 emails)"
  - Bad: "Newsletters (200 emails)", "Marketing (150 emails)"
- Order groups by archivability × size: most obviously disposable + largest win goes first
- EXCLUDE: personal emails, work correspondence, receipts the user might need, financial statements, anything with potential ongoing relevance or ambiguity
- Only include emails where archiving is clearly safe
- Each group should contain only emails matching that specific sender/pattern
- Limit examples to 5 per group (from + subject)
- Return only the emailIds that belong to each group (use the exact IDs from the input)`;

export async function categorizeEmails(emails: EmailMetadata[]): Promise<CategorizationResult> {
  const client = new Anthropic({ timeout: 10 * 60 * 1000 }); // 10 minute timeout

  // Sanitize strings to prevent special characters from breaking Claude's JSON output
  const sanitize = (s: string) => s.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\\/g, '/').replace(/"/g, "'").trim();

  const emailList = emails.map(e => ({
    id: e.id,
    from: sanitize(e.from),
    subject: sanitize(e.subject),
    date: e.date,
    snippet: sanitize(e.snippet.slice(0, 100)),
  }));

  console.log(`\nSending ${emails.length} emails to Claude for categorization...`);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Here are my unread emails. Please group the obviously archivable ones by specific sender/pattern, ordered by most disposable + largest win first.

Return your response as JSON matching this exact schema:
{
  "groups": [
    {
      "name": "string (specific sender + pattern name)",
      "description": "string (why these are safe to archive)",
      "emailIds": ["id1", "id2", ...]
    }
  ]
}

Emails:
${JSON.stringify(emailList, null, 2)}`,
      },
    ],
  });

  // Log token usage to understand output size
  console.log(`  Token usage — input: ${message.usage.input_tokens}, output: ${message.usage.output_tokens}, stop_reason: ${message.stop_reason}`);

  // Extract JSON from response
  const textBlock = message.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Parse JSON — handle possible markdown code fences
  let jsonText = textBlock.text.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    // Write full response to a debug file so we can inspect it without truncation
    const debugFile = `/tmp/claude-debug-${Date.now()}.txt`;
    const fs = await import('fs');
    fs.writeFileSync(debugFile, jsonText);
    console.error(`\nClaude returned invalid JSON.`);
    console.error(`Full response written to: ${debugFile}`);
    console.error(`Response length: ${jsonText.length} chars`);
    console.error(`Error position context: ...${jsonText.slice(Math.max(0, (err as SyntaxError).message.match(/position (\d+)/)?.[1] ? parseInt((err as SyntaxError).message.match(/position (\d+)/)![1]) - 40 : 0), ((err as SyntaxError).message.match(/position (\d+)/)?.[1] ? parseInt((err as SyntaxError).message.match(/position (\d+)/)![1]) + 40 : 80))}...`);
    throw err;
  }
  const parsed = CategorizationSchema.parse(raw);

  // Validate and deduplicate IDs against actual fetched emails
  const emailById = new Map(emails.map(e => [e.id, e]));
  const seenIds = new Set<string>();
  const validatedGroups: EmailGroup[] = [];

  for (const group of parsed.groups) {
    const filteredIds = group.emailIds.filter(id => {
      if (!emailById.has(id) || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (filteredIds.length > 0) {
      // Build examples from our own data — never from Claude's output
      const examples = filteredIds.slice(0, 5).map(id => {
        const e = emailById.get(id)!;
        return { from: e.from, subject: e.subject };
      });
      validatedGroups.push({ ...group, emailIds: filteredIds, examples });
    }
  }

  return { groups: validatedGroups };
}
