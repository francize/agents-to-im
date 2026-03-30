import {
  STREAM_ELEMENT_ID,
  STREAM_PLACEHOLDER_TEXT,
} from '../constants.js';

export function buildStreamingCardSkeleton(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: STREAM_PLACEHOLDER_TEXT,
        i18n_content: {
          zh_cn: STREAM_PLACEHOLDER_TEXT,
          en_us: 'Working on it...',
        },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: STREAM_PLACEHOLDER_TEXT,
          element_id: STREAM_ELEMENT_ID,
        },
      ],
    },
  };
}
