// Code injected into the page. tdtInstall() must stay self-contained: it is
// serialized with toString() and evaluated through CDP (Runtime.evaluate is
// exempt from page CSP, unlike eval() inside the page).
//
// Refs live in the page (WeakRef map), so they are stable across read_page
// calls and shared by every caller of this MCP server (e.g. a subagent that
// looks up a ref for the main agent). A navigation starts a fresh document,
// which naturally resets them.

export function tdtInstall() {
  const w = window as any;
  if (w.__tdt) return;

  let nextId = 1;
  const el2ref = new WeakMap<Element, string>();
  const ref2el = new Map<string, WeakRef<Element>>();

  const refOf = (el: Element): string => {
    let ref = el2ref.get(el);
    if (!ref) {
      ref = 'ref_' + nextId++;
      el2ref.set(el, ref);
      ref2el.set(ref, new WeakRef(el));
    }
    return ref;
  };

  const lookup = (ref: string): Element => {
    const el = ref2el.get(ref)?.deref();
    if (!el || !el.isConnected) {
      throw new Error(`${ref} not found: the element is gone or the page navigated. Call read_page again for fresh refs.`);
    }
    return el;
  };

  const clean = (s: string | null | undefined, max = 100): string => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR']);
  const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  ]);
  const TEXT_CONTAINERS = new Set(['generic', 'paragraph', 'listitem', 'cell', 'label', 'legend', 'caption', 'blockquote']);
  const TAG_ROLE: Record<string, string> = {
    BUTTON: 'button', SUMMARY: 'button', TEXTAREA: 'textbox', OPTION: 'option', ARTICLE: 'article',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    FORM: 'form', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', UL: 'list', OL: 'list',
    LI: 'listitem', DIALOG: 'dialog', LABEL: 'label', P: 'paragraph', DETAILS: 'group', FIELDSET: 'group',
    LEGEND: 'legend', IFRAME: 'iframe', VIDEO: 'video', AUDIO: 'audio', IMG: 'img', CAPTION: 'caption',
    BLOCKQUOTE: 'blockquote', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  };
  const INPUT_ROLE: Record<string, string> = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      if (type === 'hidden') return 'none';
      return INPUT_ROLE[type] ?? 'textbox';
    }
    if (tag === 'SELECT') {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'SECTION') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'generic';
    if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    return TAG_ROLE[tag] ?? 'generic';
  };

  const ownText = (el: Element): string => {
    if (el.children.length === 0) return el.textContent ?? '';
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent + ' ';
    return t;
  };

  const nameOf = (el: Element, role: string): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      if (clean(t)) return clean(t);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);

    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const input = el as HTMLInputElement;
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(input.type)) {
        return clean(input.value || (input.type === 'submit' ? 'Submit' : input.type === 'reset' ? 'Reset' : ''));
      }
      if (tag === 'INPUT' && input.type === 'image') return clean(input.alt || input.value);
      const labels = input.labels ? [...input.labels].map(l => l.textContent).join(' ') : '';
      if (clean(labels)) return clean(labels);
      if (tag === 'SELECT') {
        const s = el as HTMLSelectElement;
        return clean(s.selectedOptions[0]?.textContent);
      }
      return clean(el.getAttribute('title'));
    }
    if (tag === 'IMG' || tag === 'AREA') return clean(el.getAttribute('alt') ?? el.getAttribute('title'));

    let text = TEXT_CONTAINERS.has(role) ? ownText(el) : el.textContent ?? '';
    if (!clean(text) && role !== 'generic') {
      const inner = el.querySelector('img[alt], [aria-label], [title]');
      text = inner?.getAttribute('alt') || inner?.getAttribute('aria-label') || inner?.getAttribute('title') || '';
    }
    return clean(text) || clean(el.getAttribute('title'));
  };

  const isVisible = (el: Element): boolean => {
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === 'function') {
      if (!anyEl.checkVisibility({ checkVisibilityCSS: true })) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const isInteractive = (el: Element, role: string): boolean => {
    if (INTERACTIVE.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    return tabindex !== null && Number(tabindex) >= 0;
  };

  const attrsOf = (el: Element, role: string, visible: boolean): string => {
    const parts: string[] = [];
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type !== 'text') parts.push(`type="${input.type}"`);
      if (input.placeholder) parts.push(`placeholder="${clean(input.placeholder, 60)}"`);
      if (['textbox', 'searchbox', 'spinbutton', 'slider'].includes(role) && input.value) {
        parts.push(`value="${input.type === 'password' ? '••••' : clean(input.value, 60)}"`);
      }
      if (input.type === 'file' && input.files?.length) parts.push(`files=${input.files.length}`);
      if ((input.type === 'checkbox' || input.type === 'radio') && input.checked) parts.push('(checked)');
    } else if (tag === 'TEXTAREA') {
      const ta = el as HTMLTextAreaElement;
      if (ta.placeholder) parts.push(`placeholder="${clean(ta.placeholder, 60)}"`);
      if (ta.value) parts.push(`value="${clean(ta.value, 60)}"`);
    } else if (tag === 'A' && el.getAttribute('href')) {
      parts.push(`href="${clean(el.getAttribute('href'), 80)}"`);
    } else if (/^H[1-6]$/.test(tag)) {
      parts.push(`level=${tag[1]}`);
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked) parts.push(`checked=${ariaChecked}`);
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) parts.push(`expanded=${expanded}`);
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('(disabled)');
    if (!visible) parts.push('(hidden)');
    return parts.length ? ' ' + parts.join(' ') : '';
  };

  const line = (indent: number, role: string, name: string, ref: string, attrs: string) =>
    `${' '.repeat(indent)}${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ''} [${ref}]${attrs}`;

  const childrenOf = (el: Element): Element[] => {
    if (el.tagName === 'SLOT') return (el as HTMLSlotElement).assignedElements();
    if (el.shadowRoot) return [...el.shadowRoot.children];
    return [...el.children];
  };

  type Opts = { interactiveOnly: boolean };

  const walk = (el: Element, depthLeft: number, indent: number, out: string[], opts: Opts) => {
    for (const child of childrenOf(el)) {
      if (SKIP.has(child.tagName)) continue;
      const role = roleOf(child);
      if (role === 'none' || role === 'presentation') {
        if (role === 'presentation' && depthLeft > 0) walk(child, depthLeft, indent, out, opts);
        continue;
      }
      const visible = isVisible(child);
      const interactive = isInteractive(child, role);
      const isSvg = child.namespaceURI === 'http://www.w3.org/2000/svg';
      const name = isSvg ? clean(child.getAttribute('aria-label') ?? child.querySelector('title')?.textContent) : nameOf(child, role);
      const effectiveRole = isSvg ? (name ? 'img' : 'none') : role;
      if (effectiveRole === 'none') continue;

      const include = opts.interactiveOnly
        ? interactive && visible
        : effectiveRole !== 'generic' || !!name || interactive;

      if (include) {
        out.push(line(indent, effectiveRole, name, refOf(child), attrsOf(child, effectiveRole, visible)));
        if (child.tagName === 'SELECT') {
          for (const opt of (child as HTMLSelectElement).options) {
            out.push(`${' '.repeat(indent + 1)}option "${clean(opt.textContent)}"${opt.selected ? ' (selected)' : ''} value="${clean(opt.value, 60)}"`);
          }
          continue;
        }
        if (child.tagName === 'IFRAME') {
          out[out.length - 1] += ' (frame contents not traversed)';
          continue;
        }
      }
      if (isSvg) continue;
      if (include) {
        if (depthLeft > 1) walk(child, depthLeft - 1, indent + 1, out, opts);
      } else {
        walk(child, depthLeft, indent, out, opts);
      }
    }
  };

  const describe = (el: Element): string => {
    const id = el.id ? '#' + el.id : '';
    const text = clean(el.textContent, 40);
    return `<${el.tagName.toLowerCase()}${id}>${text ? ` "${text}"` : ''}`;
  };

  const api = {
    readPage(filter: string, depth: number, refId: string | null, maxChars: number): string {
      const out: string[] = [];
      const opts = { interactiveOnly: filter === 'interactive' };
      if (refId) {
        const root = lookup(refId);
        const role = roleOf(root);
        out.push(line(0, role, nameOf(root, role), refOf(root), attrsOf(root, role, isVisible(root))));
        walk(root, depth, 1, out, opts);
      } else {
        walk(document.documentElement, depth, 0, out, opts);
      }
      const doc = document.scrollingElement ?? document.documentElement;
      const footer = `\nViewport: ${doc.clientWidth}x${doc.clientHeight}  scroll: ${Math.round(scrollX)},${Math.round(scrollY)}  page: ${doc.scrollWidth}x${doc.scrollHeight}`;
      let body = out.join('\n') || '(no matching elements)';
      if (body.length > maxChars) {
        const cut = body.lastIndexOf('\n', maxChars);
        const total = body.length;
        body = body.slice(0, cut > 0 ? cut : maxChars) +
          `\n[output truncated at ${maxChars} of ${total} characters. Pass a larger max_chars, use ref_id or a smaller depth, or filter:"interactive".]`;
      }
      return body + footer;
    },

    pageText(): { title: string; url: string; source: string; text: string } {
      const pick = (sel: string) => {
        let best: HTMLElement | null = null;
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          if (!best || el.innerText.length > best.innerText.length) best = el;
        }
        return best;
      };
      const src = pick('article') ?? pick('main, [role="main"]') ?? document.body;
      return { title: document.title, url: location.href, source: `<${src.tagName.toLowerCase()}>`, text: src.innerText };
    },

    // Scrolls the element into view and returns the viewport point to click.
    pointOf(ref: string): { x: number; y: number; covered: string | null } {
      const el = lookup(ref);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        throw new Error(`${ref} ${describe(el)} has no visible box (hidden or zero size). Use form_input / file_upload, or act on a visible element such as its label.`);
      }
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? describe(hit) : null;
      return { x, y, covered };
    },

    scrollTo(ref: string): string {
      const el = lookup(ref);
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      return `Scrolled ${ref} ${describe(el)} into view (top=${Math.round(r.top)}, viewport height=${innerHeight})`;
    },

    formInput(ref: string, value: string | number | boolean): string {
      const el = lookup(ref);
      const fire = (target: Element) => {
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // Native setter so frameworks that track the value property (React) see the change.
      const setNative = (target: HTMLInputElement | HTMLTextAreaElement, v: string) => {
        const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(target, v);
      };

      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = typeof value === 'boolean' ? value : !['false', '0', '', 'off', 'no'].includes(String(value).toLowerCase());
        const prev = el.checked;
        if (prev !== want) el.click();
        return `${el.type === 'checkbox' ? 'Checkbox' : 'Radio'} ${el.checked ? 'checked' : 'unchecked'} (previous: ${prev})`;
      }
      if (el instanceof HTMLSelectElement) {
        const v = String(value);
        const opts = [...el.options];
        const opt = opts.find(o => o.value === v) ?? opts.find(o => clean(o.textContent).toLowerCase() === v.trim().toLowerCase());
        if (!opt) throw new Error(`No option matching "${v}". Options: ${opts.map(o => `"${clean(o.textContent)}" (value="${o.value}")`).join(', ')}`);
        const prev = el.value;
        el.value = opt.value;
        fire(el);
        return `Selected option "${clean(opt.textContent)}" (value="${opt.value}", previous: "${prev}")`;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el instanceof HTMLInputElement && el.type === 'file') throw new Error(`${ref} is a file input: use file_upload.`);
        const prev = el.value;
        el.focus();
        setNative(el, String(value));
        fire(el);
        const kind = el instanceof HTMLTextAreaElement ? 'textarea' : `${el.type} input`;
        const shown = el instanceof HTMLInputElement && el.type === 'password' ? '••••' : JSON.stringify(el.value);
        return `Set ${kind} value to ${shown} (previous: ${el instanceof HTMLInputElement && el.type === 'password' ? '••••' : JSON.stringify(prev)})`;
      }
      if ((el as HTMLElement).isContentEditable) {
        const prev = el.textContent ?? '';
        (el as HTMLElement).focus();
        el.textContent = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return `Set contenteditable text (previous: ${JSON.stringify(clean(prev, 60))})`;
      }
      throw new Error(`${ref} ${describe(el)} is not a form control (input, textarea, select, contenteditable).`);
    },

    lookup,
  };

  Object.defineProperty(w, '__tdt', { value: api, enumerable: false });
}

const INSTALL_SRC = `(${tdtInstall.toString()})();`;

// Expression that installs the helpers (idempotent) and calls one of them.
export function tdtCall(method: string, ...args: unknown[]): string {
  return `${INSTALL_SRC} window.__tdt.${method}(...${JSON.stringify(args)})`;
}
