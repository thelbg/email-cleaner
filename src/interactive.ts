import * as readline from 'readline';
import type { EmailGroup } from './types.js';

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function presentGroup(
  group: EmailGroup,
  currentUnread: number,
): Promise<'archive' | 'skip' | 'quit'> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const afterCount = currentUnread - group.emailIds.length;

  console.log('\n' + '─'.repeat(60));
  console.log(`📁  ${group.name}`);
  console.log(`    ${group.description}`);
  console.log(`    ${group.emailIds.length} emails  |  Unread: ${currentUnread} → ${afterCount}`);
  console.log('\n  Examples:');
  for (const ex of group.examples.slice(0, 5)) {
    const from = ex.from.length > 40 ? ex.from.slice(0, 37) + '...' : ex.from;
    const subject = ex.subject.length > 60 ? ex.subject.slice(0, 57) + '...' : ex.subject;
    console.log(`    • ${from}`);
    console.log(`      ${subject}`);
  }
  console.log('');

  let answer: 'archive' | 'skip' | 'quit';

  while (true) {
    const input = (await prompt(rl, '  (y)es archive / (n)o skip / (q)uit: ')).trim().toLowerCase();
    if (input === 'y' || input === 'yes') {
      answer = 'archive';
      break;
    } else if (input === 'n' || input === 'no') {
      answer = 'skip';
      break;
    } else if (input === 'q' || input === 'quit') {
      answer = 'quit';
      break;
    } else {
      console.log('  Please enter y, n, or q.');
    }
  }

  rl.close();
  return answer;
}
