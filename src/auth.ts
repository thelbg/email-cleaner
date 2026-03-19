import { google } from 'googleapis';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '..', '.token.json');
const REDIRECT_URI = 'http://localhost:3000';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

async function getTokenViaBrowser(client: ReturnType<typeof createOAuth2Client>): Promise<void> {
  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

  console.log('\nOpening browser for Gmail authorization...');
  console.log('If the browser does not open, visit:\n', authUrl);

  // Try to open browser
  const { exec } = await import('child_process');
  exec(`open "${authUrl}"`);

  // Spin up local server to capture code
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:3000`);
      const code = url.searchParams.get('code');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful! You can close this tab.</h1>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end('Missing code parameter');
        reject(new Error('Missing code parameter'));
      }
    });
    server.listen(3000, () => {
      console.log('Waiting for authorization on http://localhost:3000 ...');
    });
    server.on('error', reject);
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token saved to .token.json\n');
}

export async function getAuthClient() {
  const client = createOAuth2Client();

  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    client.setCredentials(tokens);
    // Refresh if expired
    if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
    }
  } else {
    await getTokenViaBrowser(client);
  }

  return client;
}
