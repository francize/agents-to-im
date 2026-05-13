import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeAssistantMarkdown } from '../bridge/markdown/sanitizer.js';

describe('sanitizeAssistantMarkdown', () => {
  it('passes plain text through unchanged', () => {
    const result = sanitizeAssistantMarkdown('hello **world**');
    assert.equal(result.text, 'hello **world**');
    assert.equal(result.truncated, false);
  });

  it('replaces javascript: links with about:blank, preserves label', () => {
    const input = 'click [me](javascript:alert(1)) here';
    const { text } = sanitizeAssistantMarkdown(input);
    assert.equal(text, 'click [me](about:blank) here');
  });

  it('replaces data:text/html links and vbscript variants', () => {
    const { text: html } = sanitizeAssistantMarkdown('[x](data:text/html,<svg/onload=alert(1)>)');
    assert.match(html, /\(about:blank\)$/);
    const { text: vb } = sanitizeAssistantMarkdown('[x](vbscript:msgbox)');
    assert.equal(vb, '[x](about:blank)');
  });

  it('leaves safe http(s) links intact', () => {
    const input = '[doc](https://example.com/path?a=1)';
    const { text } = sanitizeAssistantMarkdown(input);
    assert.equal(text, input);
  });

  it('neutralizes dangerous autolinks', () => {
    const { text } = sanitizeAssistantMarkdown('<javascript:alert(1)>');
    assert.equal(text, '<about:blank>');
  });

  it('strips <think> blocks (both block and standalone tags)', () => {
    const { text: a } = sanitizeAssistantMarkdown('a<think>secret reasoning</think>b');
    assert.equal(a, 'ab');
    const { text: b } = sanitizeAssistantMarkdown('a</think>b<think>c');
    assert.equal(b, 'abc');
  });

  it('strips <script> / <style> / <iframe> blocks', () => {
    const { text } = sanitizeAssistantMarkdown('hi<script>evil()</script> there<style>a{}</style>');
    assert.equal(text, 'hi there');
    const { text: iframe } = sanitizeAssistantMarkdown('<iframe src="x"></iframe>x');
    assert.equal(iframe, 'x');
  });

  it('pads short separator row to match header column count', () => {
    const input = ['| a | b |', '| --- |', '| 1 | 2 |'].join('\n');
    const { text } = sanitizeAssistantMarkdown(input);
    assert.equal(text, ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
  });

  it('pads short body rows to match header column count', () => {
    const input = ['| a | b | c |', '| --- | --- | --- |', '| 1 |'].join('\n');
    const { text } = sanitizeAssistantMarkdown(input);
    assert.equal(text, ['| a | b | c |', '| --- | --- | --- |', '| 1 |  |  |'].join('\n'));
  });

  it('truncates content larger than byte limit and appends marker', () => {
    const big = 'x'.repeat(30 * 1024);
    const { text, truncated } = sanitizeAssistantMarkdown(big, { byteLimit: 24 * 1024 });
    assert.equal(truncated, true);
    assert.ok(text.endsWith('_…内容过长已截断_'));
    assert.ok(Buffer.byteLength(text, 'utf8') <= 24 * 1024);
  });

  it('truncates without splitting a multi-byte UTF-8 codepoint', () => {
    const emoji = '😀';
    const filler = '汉'.repeat(8000);
    const input = filler + emoji.repeat(100);
    const { text, truncated } = sanitizeAssistantMarkdown(input, { byteLimit: 1024 });
    assert.equal(truncated, true);
    const beforeMarker = text.replace(/_…内容过长已截断_$/, '').trimEnd();
    assert.doesNotThrow(() => {
      const buf = Buffer.from(beforeMarker, 'utf8');
      const roundtrip = buf.toString('utf8');
      assert.equal(roundtrip, beforeMarker);
    });
    assert.ok(!/�/.test(text), 'should not contain replacement character');
  });

  it('returns empty for empty input', () => {
    const { text, truncated } = sanitizeAssistantMarkdown('');
    assert.equal(text, '');
    assert.equal(truncated, false);
  });
});
