import { describe, it, expect } from 'bun:test';
import { formAnswerSchema, toQuestionAnswers, toQuestionForm } from './question-form.js';

describe('toQuestionForm', () => {
  it('asks each question as one field, a choice list when it has options', () => {
    const form = toQuestionForm('ses_1', {
      requestId: 'req-1',
      title: 'Color question',
      questions: [
        { id: 'q0', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }], multiple: false, custom: true },
        { id: 'q1', question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }], multiple: true, custom: false },
        { id: 'q2', question: 'Anything else?', options: [], multiple: false, custom: false },
      ],
    });

    expect(form).toEqual({
      id: 'req-1',
      sessionID: 'ses_1',
      title: 'Color question',
      fields: [
        {
          key: 'q0',
          type: 'string',
          title: 'Color',
          description: 'Which color?',
          required: true,
          options: [{ value: 'Red', label: 'Red', description: 'Warm' }, { value: 'Blue', label: 'Blue' }],
          custom: true,
        },
        { key: 'q1', type: 'multiselect', title: 'Which sizes?', required: true, options: [{ value: 'S', label: 'S' }, { value: 'M', label: 'M' }], custom: false },
        { key: 'q2', type: 'string', title: 'Anything else?', required: true },
      ],
    });
  });

  it('leaves the title to the UI when the engine names none', () => {
    expect(toQuestionForm('ses_1', { requestId: 'req-1', questions: [{ id: 'q0', question: 'Go on?', options: [] }] }).title).toBe('');
  });
});

describe('toQuestionAnswers', () => {
  it('reads every field of the reply as a list of answers', () => {
    const answer = formAnswerSchema.parse({ q0: 'Blue', q1: ['S', 'M'], q2: 3, q3: true });
    expect(toQuestionAnswers(answer)).toEqual({ q0: ['Blue'], q1: ['S', 'M'], q2: ['3'], q3: ['true'] });
  });

  it('refuses a reply that is not one value per field', () => {
    expect(formAnswerSchema.safeParse({ q0: { nested: true } }).success).toBe(false);
    expect(formAnswerSchema.safeParse('Blue').success).toBe(false);
  });
});
