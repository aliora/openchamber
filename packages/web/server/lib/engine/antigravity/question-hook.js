import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const QUESTION_TOOL = 'ask_question';
const HOOK_SCRIPT = 'ask-question.sh';
const HOOK_TIMEOUT_SECONDS = 86_400;
const POLL_INTERVAL_MS = 250;
const QUESTIONS = 'questions';
const ANSWERS = 'answers';

const HOOK_CONFIG = {
  'openchamber-questions': {
    PreToolUse: [{ matcher: QUESTION_TOOL, hooks: [{ type: 'command', command: `sh ${HOOK_SCRIPT}`, timeout: HOOK_TIMEOUT_SECONDS }] }],
  },
};

const SCRIPT = `id=$$
cat > "${QUESTIONS}/$id.tmp" && mv "${QUESTIONS}/$id.tmp" "${QUESTIONS}/$id.json" || exit 1
while [ ! -f "${ANSWERS}/$id.json" ]; do
  [ -d ${ANSWERS} ] || exit 1
  sleep 0.2
done
cat "${ANSWERS}/$id.json"
rm -f "${ANSWERS}/$id.json"
`;

const hookInputSchema = z.object({
  toolCall: z.object({
    name: z.literal(QUESTION_TOOL),
    args: z.object({
      toolSummary: z.string().min(1).optional().catch(undefined),
      questions: z.array(z.object({
        question: z.string().min(1),
        options: z.array(z.string().min(1)).catch([]).default([]),
        is_multi_select: z.boolean().catch(false).default(false),
      })).min(1),
    }),
  }),
});

const writePrivateFile = (file, content) => fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });

export const writeQuestionHook = (pluginDirectory) => {
  fs.mkdirSync(path.join(pluginDirectory, QUESTIONS), { mode: 0o700 });
  fs.mkdirSync(path.join(pluginDirectory, ANSWERS), { mode: 0o700 });
  writePrivateFile(path.join(pluginDirectory, 'hooks.json'), JSON.stringify(HOOK_CONFIG));
  writePrivateFile(path.join(pluginDirectory, HOOK_SCRIPT), SCRIPT);
};

const readQuestion = (file) => {
  try {
    const parsed = hookInputSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.toolCall.args : null;
  } catch {
    return null;
  }
};

export const watchAgyQuestions = ({ directory, onQuestion, intervalMs = POLL_INTERVAL_MS }) => {
  const questionsDirectory = path.join(directory, QUESTIONS);
  const seen = new Set();

  const answer = (id, decision) => {
    const file = path.join(directory, ANSWERS, `${id}.json`);
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(decision), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      fs.rmSync(path.join(questionsDirectory, `${id}.json`), { force: true });
    } catch (error) {
      console.warn('[engine] Antigravity question hook could not be answered:', error instanceof Error ? error.message : String(error));
    }
  };

  const scan = () => {
    let names;
    try {
      names = fs.readdirSync(questionsDirectory);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json') || seen.has(name)) continue;
      seen.add(name);
      const id = name.slice(0, -'.json'.length);
      const args = readQuestion(path.join(questionsDirectory, name));
      if (!args) {
        answer(id, {});
        continue;
      }
      onQuestion({
        id,
        title: args.toolSummary,
        questions: args.questions.map(({ question, options, is_multi_select: multiple }) => ({ question, options, multiple })),
      });
    }
  };

  const timer = setInterval(scan, intervalMs);
  timer.unref();
  return { answer, stop: () => clearInterval(timer) };
};
