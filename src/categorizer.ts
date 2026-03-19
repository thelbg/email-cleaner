import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { EmailMetadata, EmailGroup, CategorizationResult } from './types.js';

const GroupSchema = z.object({
  name: z.string(),
  description: z.string(),
  emailIds: z.array(z.string()),
  examples: z.array(z.object({ from: z.string(), subject: z.string() })).max(5),
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
  const client = new Anthropic();

  // Prepare compact email list for Claude
  const emailList = emails.map(e => ({
    id: e.id,
    from: e.from,
    subject: e.subject,
    date: e.date,
    snippet: e.snippet.slice(0, 100),
  }));

  console.log(`\nSending ${emails.length} emails to Claude for categorization...`);

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
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
      "emailIds": ["id1", "id2", ...],
      "examples": [{"from": "...", "subject": "..."}] // up to 5
    }
  ]
}

Emails:
${JSON.stringify(emailList, null, 2)}`,
      },
    ],
  });

  // Extract JSON from response
  const textBlock = message.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Parse JSON — handle possible markdown code fences
  let jsonText = textBlock.text.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  const raw = JSON.parse(jsonText);
  const parsed = CategorizationSchema.parse(raw);

  // Validate and deduplicate IDs against actual fetched emails
  const validIds = new Set(emails.map(e => e.id));
  const seenIds = new Set<string>();
  const validatedGroups: EmailGroup[] = [];

  for (const group of parsed.groups) {
    const filteredIds = group.emailIds.filter(id => {
      if (!validIds.has(id) || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (filteredIds.length > 0) {
      validatedGroups.push({ ...group, emailIds: filteredIds });
    }
  }

  return { groups: validatedGroups };
}
