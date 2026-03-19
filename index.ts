import 'dotenv/config';
import { getAuthClient } from './src/auth.js';
import { fetchUnreadEmails, archiveEmails, getUnreadCount } from './src/gmail.js';
import { categorizeEmails } from './src/categorizer.js';
import { presentGroup } from './src/interactive.js';

async function main() {
  // Validate env
  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'ANTHROPIC_API_KEY'].filter(
    k => !process.env[k],
  );
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }

  console.log('=== Email Spring Cleaner ===\n');

  // 1. Auth
  const auth = await getAuthClient();

  // 2. Fetch unread emails
  const emails = await fetchUnreadEmails(auth, 500);
  console.log(`Found ${emails.length} unread emails.`);

  if (emails.length === 0) {
    console.log('Inbox is clean! Nothing to do.');
    return;
  }

  // 3. Categorize with Claude
  const { groups } = await categorizeEmails(emails);

  if (groups.length === 0) {
    console.log('\nClaude found no obvious archival candidates. Your inbox looks good!');
    return;
  }

  const totalCandidates = groups.reduce((sum, g) => sum + g.emailIds.length, 0);
  console.log(`\nFound ${groups.length} groups with ${totalCandidates} archival candidates:\n`);
  for (const g of groups) {
    console.log(`  • ${g.name} (${g.emailIds.length})`);
  }

  // 4. Interactive loop
  let currentUnread = await getUnreadCount(auth);
  let totalArchived = 0;

  for (const group of groups) {
    const action = await presentGroup(group, currentUnread);

    if (action === 'archive') {
      process.stdout.write(`  Archiving ${group.emailIds.length} emails...`);
      await archiveEmails(auth, group.emailIds);
      currentUnread -= group.emailIds.length;
      totalArchived += group.emailIds.length;
      console.log(' done.');
    } else if (action === 'skip') {
      console.log('  Skipped.');
    } else {
      console.log('\nQuitting early.');
      break;
    }
  }

  // 5. Summary
  console.log('\n' + '═'.repeat(60));
  console.log(`Done! Archived ${totalArchived} emails.`);
  console.log(`Remaining unread: ${currentUnread}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
