import { z } from 'zod';

export const formAnswerSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));

const toChoice = ({ label, description }) => (description ? { value: label, label, description } : { value: label, label });

const toField = ({ id, header, question, options = [], multiple = false, custom = false }) => {
  const field = { key: id, title: header || question, required: true };
  if (header) field.description = question;
  if (options.length === 0) return { ...field, type: 'string' };
  return { ...field, type: multiple ? 'multiselect' : 'string', options: options.map(toChoice), custom };
};

export const toQuestionForm = (sessionId, { requestId, title, questions }) => ({
  id: requestId,
  sessionID: sessionId,
  title: title ?? '',
  fields: questions.map(toField),
});

export const toQuestionAnswers = (answer) => Object.fromEntries(
  Object.entries(answer).map(([key, value]) => [key, (Array.isArray(value) ? value : [value]).map(String)]),
);
