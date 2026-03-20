import 'dotenv/config';
import { getAuthClient } from './src/auth.js';
import { fetchAllUnreadIds, fetchEmailMetadata, archiveEmails, getUnreadCount } from './src/gmail.js';
import { categorizeEmails } from './src/categorizer.js';
import { presentGroup } from './src/interactive.js';

const BATCH_SIZE = 100;

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

  // 2. Fetch all unread IDs upfront
  process.stdout.write('Fetching unread email list...');
  const allIds = await fetchAllUnreadIds(auth);
  console.log(` ${allIds.length} unread emails found.\n`);

  if (allIds.length === 0) {
    console.log('Inbox is clean! Nothing to do.');
    return;
  }

  const totalBatches = Math.ceil(allIds.length / BATCH_SIZE);
  let currentUnread = await getUnreadCount(auth);
  let totalArchived = 0;
  let quit = false;

  // 3. Process in batches
  for (let batchIndex = 0; batchIndex < totalBatches && !quit; batchIndex++) {
    const batchIds = allIds.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);

    console.log(`─── Batch ${batchIndex + 1}/${totalBatches} (emails ${batchIndex * BATCH_SIZE + 1}–${batchIndex * BATCH_SIZE + batchIds.length} of ${allIds.length}) ───\n`);

    // Fetch metadata for this batch
    const emails = await fetchEmailMetadata(auth, batchIds);

    // Categorize with Claude
    const { groups } = await categorizeEmails(emails);

    if (groups.length === 0) {
      console.log('No obvious archival candidates in this batch.\n');
      continue;
    }

    const totalCandidates = groups.reduce((sum, g) => sum + g.emailIds.length, 0);
    console.log(`\nFound ${groups.length} groups with ${totalCandidates} archival candidates:\n`);
    for (const g of groups) {
      console.log(`  • ${g.name} (${g.emailIds.length})`);
    }

    // Interactive loop for this batch
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
        quit = true;
        console.log('\nQuitting early.');
        break;
      }
    }

    if (!quit && batchIndex < totalBatches - 1) {
      console.log(`\nBatch ${batchIndex + 1} complete. Moving to next batch...\n`);
    }
  }

  // 4. Summary
  console.log('\n' + '═'.repeat(60));
  console.log(`Done! Archived ${totalArchived} emails.`);
  console.log(`Remaining unread: ${currentUnread}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
