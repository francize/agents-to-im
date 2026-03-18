declare module 'markdown-it' {
  export type Token = {
    type: string;
    content?: string;
    children?: Token[];
    attrs?: [string, string][];
    attrGet?: (name: string) => string | null;
  };

  export default class MarkdownIt {
    constructor(options?: {
      html?: boolean;
      linkify?: boolean;
      breaks?: boolean;
      typographer?: boolean;
    });

    enable(rule: string): this;
    disable(rule: string): this;
    parse(src: string, env: unknown): Token[];
  }
}
