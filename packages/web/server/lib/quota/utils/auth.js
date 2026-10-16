import fs from 'fs';

export const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    // The file may hold credentials, and a JSON syntax error quotes the text it
    // choked on, so only the error class and code are logged.
    console.warn(`Failed to read JSON file: ${filePath} (${error?.code ?? error?.name ?? 'unknown error'})`);
    return null;
  }
};
