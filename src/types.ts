export interface EmailMetadata {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface EmailGroup {
  name: string;
  description: string;
  emailIds: string[];
  examples: Array<{ from: string; subject: string }>;
}

export interface CategorizationResult {
  groups: EmailGroup[];
}
