// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { manualEditKindForElement } from '../../src/edit-mode/bridge';

function makeEl(html: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
}

describe('manualEditKindForElement', () => {
  it('treats a bare div holding only text as editable text (not a container)', () => {
    // Regression: card titles authored as <div>Text</div> used to be forced to
    // 'container' purely by tag name, so the text cursor never appeared.
    expect(manualEditKindForElement(makeEl('<div>Sprint board</div>'))).toBe('text');
  });

  it('treats a div with block-level children as a container', () => {
    expect(manualEditKindForElement(makeEl('<div><p>one</p><p>two</p></div>'))).toBe('container');
  });

  it('treats a div wrapping only inline formatting as editable text', () => {
    expect(manualEditKindForElement(makeEl('<div>Hello <strong>world</strong></div>'))).toBe('text');
  });

  it('treats list items as editable text', () => {
    expect(manualEditKindForElement(makeEl('<li>Backlog item</li>'))).toBe('text');
  });

  it('treats table cells as editable text', () => {
    const table = document.createElement('table');
    table.innerHTML = '<tbody><tr><td>3 pts</td></tr></tbody>';
    expect(manualEditKindForElement(table.querySelector('td')!)).toBe('text');
  });

  it('treats h4/h5/h6 headings as editable text', () => {
    expect(manualEditKindForElement(makeEl('<h4>Sub heading</h4>'))).toBe('text');
    expect(manualEditKindForElement(makeEl('<h6>Fine print</h6>'))).toBe('text');
  });

  it('keeps paragraphs with inline children editable', () => {
    expect(manualEditKindForElement(makeEl('<p>See <a href="#">link</a> now</p>'))).toBe('text');
  });

  it('keeps anchors as links and images as images', () => {
    expect(manualEditKindForElement(makeEl('<a href="#">Go</a>'))).toBe('link');
    expect(manualEditKindForElement(makeEl('<img src="x.png" alt="x" />'))).toBe('image');
  });

  it('treats an empty container as a container, not text', () => {
    expect(manualEditKindForElement(makeEl('<div></div>'))).toBe('container');
  });

  it('respects an explicit data-od-edit override', () => {
    expect(manualEditKindForElement(makeEl('<div data-od-edit="container">Text</div>'))).toBe('container');
  });
});
