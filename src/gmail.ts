import { google } from 'googleapis';
import type { EmailMetadata } from './types.js';

type AuthClient = Awaited<ReturnType<typeof import('./auth.js').getAuthClient>>;

function getGmailClient(auth: AuthClient) {
  return google.gmail({ version: 'v1', auth });
}

function extractHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export async function fetchAllUnreadIds(auth: AuthClient): Promise<string[]> {
  const gmail = getGmailClient(auth);
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (true) {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 500,
      pageToken,
    });

    const messages = res.data.messages ?? [];
    ids.push(...messages.map(m => m.id!));

    if (!res.data.nextPageToken) break;
    pageToken = res.data.nextPageToken;
  }

  return ids;
}

export async function fetchEmailMetadata(auth: AuthClient, ids: string[]): Promise<EmailMetadata[]> {
  const gmail = getGmailClient(auth);
  const CHUNK_SIZE = 50;
  const emails: EmailMetadata[] = [];

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(id =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        }),
      ),
    );

    for (const res of results) {
      const msg = res.data;
      const headers = msg.payload?.headers ?? [];
      emails.push({
        id: msg.id!,
        from: extractHeader(headers, 'From'),
        subject: extractHeader(headers, 'Subject'),
        date: extractHeader(headers, 'Date'),
        snippet: msg.snippet ?? '',
      });
    }

    process.stdout.write(`\rFetching metadata... ${Math.min(i + CHUNK_SIZE, ids.length)}/${ids.length}`);
  }

  process.stdout.write('\n');
  return emails;
}

export async function archiveEmails(auth: AuthClient, ids: string[]): Promise<void> {
  const gmail = getGmailClient(auth);
  const CHUNK_SIZE = 1000;

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: chunk,
        removeLabelIds: ['INBOX', 'UNREAD'],
      },
    });
  }
}

export async function getUnreadCount(auth: AuthClient): Promise<number> {
  const gmail = getGmailClient(auth);
  const res = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
  return res.data.messagesUnread ?? 0;
}
