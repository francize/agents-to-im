import type * as lark from '@larksuiteoapi/node-sdk';

import { buildInteractionTimeoutMarkdown, buildInteractionTimeoutText } from '../../bridge/interaction-timeout.js';
import type {
  StructuredInputRequestInfo,
  StructuredInputResponse,
} from '../../bridge/host.js';
import { PENDING_STRUCTURED_INPUTS_TIMEOUT_MS } from '../../providers/claude/permission-gateway.js';
import { STRUCTURED_INPUT_PREFIX } from '../constants.js';
import { collectTextFragments } from '../utils.js';
import type { StructuredInputCardOptions } from '../types.js';

export function buildStructuredFieldName(
  requestId: string,
  questionId: string,
  kind: 'answer' | 'other',
): string {
  const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${STRUCTURED_INPUT_PREFIX}_${sanitize(requestId)}_${kind}_${sanitize(questionId)}`;
}

export function buildStructuredInputQuestionElements(
  request: StructuredInputRequestInfo,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: '继续前需要你补充一些信息。',
    },
  ];

  for (const question of request.questions) {
    const singleSelectReasonLines = question.options?.length && !question.multiSelect
      ? question.options
          .filter((option) => option.description)
          .map((option, index) => `${index + 1}. ${option.label}：${option.description}`)
      : [];
    elements.push({
      tag: 'markdown',
      content: [
        `**${question.header || question.id}**`,
        question.question,
        ...(singleSelectReasonLines.length > 0 ? ['', '可选项说明：', ...singleSelectReasonLines] : []),
      ].join('\n'),
    });

    if (question.options?.length && !question.multiSelect) {
      elements.push({
        tag: 'select_static',
        name: buildStructuredFieldName(request.requestId, question.id, 'answer'),
        placeholder: {
          tag: 'plain_text',
          content: '请选择',
        },
        width: 'fill',
        options: question.options.map((option) => ({
          text: {
            tag: 'plain_text',
            content: option.label,
          },
          value: option.label,
        })),
      });
    }

    if (question.options?.length && question.multiSelect) {
      const optionLines = question.options.map((option, index) => {
        const summary = option.description ? `：${option.description}` : '';
        return `${index + 1}. ${option.label}${summary}`;
      });
      elements.push({
        tag: 'markdown',
        content: ['可选项：', ...optionLines].join('\n'),
      });
    }

    if (!question.options?.length || question.isOther || question.multiSelect) {
      elements.push({
        tag: 'input',
        name: buildStructuredFieldName(request.requestId, question.id, 'other'),
        width: 'fill',
        placeholder: {
          tag: 'plain_text',
          content: question.multiSelect
            ? '如需多个答案，请用逗号分隔；也可直接填写自定义内容'
            : question.options?.length
              ? '可补充自定义答案'
              : '请输入答案',
        },
      });
    }

    if (question.options?.length && question.isOther && !question.multiSelect) {
      elements.push({
        tag: 'markdown',
        content: '如果预设选项都不合适，可填写上面的自定义输入框。',
      });
    }

    if (question.options?.length && question.multiSelect) {
      elements.push({
        tag: 'markdown',
        content: '如果需要多个预设选项，请在输入框中使用英文逗号分隔；若都不合适，也可以直接填写自定义答案。',
      });
    }
  }

  elements.push({
    tag: 'markdown',
    content: buildInteractionTimeoutMarkdown(PENDING_STRUCTURED_INPUTS_TIMEOUT_MS, '将按未补充处理'),
  });

  elements.push({
    tag: 'column_set',
    horizontal_align: 'right',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            name: `submit_${request.requestId}`,
            form_action_type: 'submit',
            type: 'primary',
            text: {
              tag: 'plain_text',
              content: '提交',
            },
            behaviors: [
              {
                type: 'callback',
                value: {
                  callback_data: `input:submit:${request.requestId}`,
                },
              },
            ],
          },
        ],
      },
    ],
  });

  return [
    {
      tag: 'form',
      name: `form_${request.requestId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      elements,
    },
  ];
}

export function buildResolvedStructuredInputElements(
  request: StructuredInputRequestInfo,
  note: string,
  answers?: StructuredInputResponse['answers'],
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: note,
      },
    },
  ];
  for (const question of request.questions) {
    const submitted = answers?.[question.id]?.answers
      ?.map((answer) => answer.trim())
      .filter(Boolean) || [];
    const formattedSubmitted = submitted.map((answer) => {
      const option = question.options?.find((candidate) => candidate.label.trim() === answer);
      if (option?.description) {
        return `${answer} (${option.description})`;
      }
      return answer;
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${question.header || question.id}**\n${question.question}`,
      },
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: formattedSubmitted.length > 0
          ? `已提交：${formattedSubmitted.join(' / ')}`
          : '已提交：未记录答案',
      },
    });
  }
  return elements;
}

export function buildStructuredInputCard(
  request: StructuredInputRequestInfo,
  options?: StructuredInputCardOptions,
): Record<string, unknown> {
  const elements = options?.resolved
    ? buildResolvedStructuredInputElements(
        request,
        options.note || '该问答已完成，正在继续执行。',
        options.answers,
      )
    : buildStructuredInputQuestionElements(request);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '补充信息',
      },
      template: 'wathet',
    },
    body: {
      elements,
    },
  };
}

export function buildStructuredInputFallbackText(request: StructuredInputRequestInfo): string {
  const lines: string[] = [
    '继续前需要你补充一些信息。',
    buildInteractionTimeoutText(PENDING_STRUCTURED_INPUTS_TIMEOUT_MS, '将按未补充处理'),
    '',
  ];
  request.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header || question.id}`);
    lines.push(question.question);
    if (question.options?.length) {
      const optionsText = question.options
        .map((option) => option.description ? `${option.label}：${option.description}` : option.label)
        .join(' / ');
      lines.push(`可选项：${optionsText}`);
      if (question.multiSelect) {
        lines.push('如果需要多个选项，请使用逗号分隔输入。');
      }
    }
    lines.push('');
  });
  lines.push('当前交互卡发送失败，请转到本地命令行继续，或稍后重试。');
  return lines.join('\n').trim();
}

export function normalizeStructuredAnswers(
  question: StructuredInputRequestInfo['questions'][number],
  selected: string[],
  other: string[],
): string[] {
  const values = [...selected, ...other]
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return [];
  if (!question.multiSelect) {
    return Array.from(new Set(values));
  }

  const optionLabels = new Set(
    (question.options || [])
      .map((option) => option.label.trim())
      .filter(Boolean),
  );
  const normalized: string[] = [];
  for (const value of values) {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (
      parts.length > 1
      && optionLabels.size > 0
      && parts.every((part) => optionLabels.has(part))
    ) {
      normalized.push(...parts);
      continue;
    }
    normalized.push(value);
  }
  return Array.from(new Set(normalized));
}

export function extractStructuredAnswers(
  request: StructuredInputRequestInfo,
  value: Record<string, unknown> | undefined,
  persistedAnswers?: StructuredInputResponse['answers'],
): StructuredInputResponse {
  const answers: StructuredInputResponse['answers'] = persistedAnswers
    ? JSON.parse(JSON.stringify(persistedAnswers))
    : {};
  const record = value || {};
  for (const question of request.questions) {
    const selected = collectTextFragments(record[buildStructuredFieldName(request.requestId, question.id, 'answer')]);
    const other = collectTextFragments(record[buildStructuredFieldName(request.requestId, question.id, 'other')]);
    const resolved = normalizeStructuredAnswers(question, selected, other);
    if (resolved.length > 0) {
      answers[question.id] = { answers: resolved };
    }
  }
  return { answers };
}

export function isStructuredInputFieldInteraction(event: lark.InteractiveCardActionEvent): boolean {
  const tag = typeof event.action?.tag === 'string' ? event.action.tag : '';
  if (tag === 'select_static' || tag === 'select_person' || tag === 'input') {
    return true;
  }
  const value = event.action?.value;
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => key.startsWith(`${STRUCTURED_INPUT_PREFIX}:`));
}
