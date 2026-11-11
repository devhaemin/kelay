// Kelay preview interactions: mobile menu, tabs, listbox popover (APG pattern), copy,
// board moves, simulator, agenda approval count.

(() => {
  const live = document.querySelector('[data-live]');
  const announce = (text) => { if (live) live.textContent = text; };

  // Mobile menu: disclosure button controls the collapsible part of the sidebar.
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.querySelector('.menu-toggle');
  if (sidebar && toggle) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '메뉴 닫기' : '메뉴';
      sidebar.toggleAttribute('data-open', open);
    });
  }

  // Tabs: roving tabindex, arrow keys move and activate.
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        let next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        if (e.key === 'Home') next = tabs[0];
        if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next); next.focus(); }
      });
    });
  });

  // Listbox popover. A trigger names its option set with data-options="<template id>".
  // The chosen value is mirrored on the trigger as data-value and in its [data-label-slot].
  let openState = null;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const closeListbox = (restoreFocus = true) => {
    if (!openState) return;
    const { box, trigger } = openState;
    box.removeAttribute('data-open');
    trigger.setAttribute('aria-expanded', 'false');
    if (reduceMotion()) box.remove();
    else setTimeout(() => box.remove(), 150);
    if (restoreFocus && trigger.isConnected) trigger.focus();
    openState = null;
  };

  const openListbox = (trigger) => {
    closeListbox(false);
    const tpl = document.getElementById(trigger.dataset.options);
    if (!tpl) return;
    const box = document.createElement('div');
    box.className = 'listbox';
    box.setAttribute('role', 'listbox');
    box.tabIndex = -1;
    box.id = `lb-${Math.random().toString(36).slice(2, 8)}`;
    box.setAttribute('aria-label', trigger.dataset.label || '선택');
    box.append(tpl.content.cloneNode(true));
    const options = [...box.querySelectorAll('[role="option"]')];
    options.forEach((o, i) => {
      o.classList.add('option');
      o.id = `${box.id}-${i}`;
      o.setAttribute('aria-selected', String(o.dataset.value === trigger.dataset.value));
    });
    document.body.append(box);

    const r = trigger.getBoundingClientRect();
    const width = Math.max(r.width, 200);
    const maxLeft = window.scrollX + document.documentElement.clientWidth - width - 16;
    const left = Math.max(window.scrollX + 16, Math.min(r.left + window.scrollX, maxLeft));
    box.style.minWidth = `${width}px`;
    box.style.left = `${left}px`;
    box.style.top = `${r.bottom + window.scrollY + 4}px`;

    let active = Math.max(0, options.findIndex((o) => o.getAttribute('aria-selected') === 'true'));
    const setActive = (i) => {
      options.forEach((o) => o.removeAttribute('data-active'));
      active = (i + options.length) % options.length;
      options[active].setAttribute('data-active', '');
      box.setAttribute('aria-activedescendant', options[active].id);
    };
    const choose = (o) => {
      const changed = trigger.dataset.value !== o.dataset.value;
      trigger.dataset.value = o.dataset.value;
      const slot = trigger.querySelector('[data-label-slot]') || trigger;
      slot.textContent = o.dataset.text;
      closeListbox();
      if (changed) {
        trigger.removeAttribute('data-proposed');
        trigger.dispatchEvent(new CustomEvent('listbox:change', { bubbles: true, detail: { value: o.dataset.value, text: o.dataset.text } }));
      }
    };

    options.forEach((o, i) => {
      o.addEventListener('mousemove', () => setActive(i));
      o.addEventListener('click', () => choose(o));
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
      else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); closeListbox(); }
      else if (e.key === 'Tab') { closeListbox(false); }
    });

    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', box.id);
    setActive(active);
    requestAnimationFrame(() => box.setAttribute('data-open', ''));
    box.focus();
    openState = { box, trigger };
  };

  document.querySelectorAll('[aria-haspopup="listbox"]').forEach((trigger) => {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => {
      if (openState && openState.trigger === trigger) closeListbox();
      else openListbox(trigger);
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openListbox(trigger); }
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (openState && !openState.box.contains(e.target) && !openState.trigger.contains(e.target)) closeListbox(false);
  });
  window.addEventListener('resize', () => closeListbox(false));

  // Copy buttons: data-copy holds the text; the button reports the result in its own label.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const original = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = '복사했어요';
      } catch {
        btn.textContent = '복사하지 못했어요';
      }
      setTimeout(() => { btn.textContent = original; }, 1600);
    });
  });

  // Board: choosing a status moves the ticket into that lane and updates both lane counts.
  const recount = () => {
    document.querySelectorAll('.lane').forEach((lane) => {
      const n = lane.querySelectorAll('.ticket').length;
      const c = lane.querySelector('[data-lane-count]');
      if (c) c.textContent = String(n);
    });
  };
  document.addEventListener('listbox:change', (e) => {
    const mover = e.target.closest('.move');
    if (!mover) return;
    const ticket = mover.closest('.ticket');
    const list = document.querySelector(`.lane[data-lane="${e.detail.value}"] .lane-list`);
    if (!ticket || !list) return;
    list.prepend(ticket);
    recount();
    mover.focus();
    const title = ticket.querySelector('.ticket-title')?.textContent ?? '티켓';
    announce(`${title}을(를) ${e.detail.text}(으)로 옮겼어요.`);
  });

  // Simulator: a person picker rewrites the result lines from the chosen option's data.
  document.addEventListener('listbox:change', (e) => {
    const picker = e.target.closest('[data-simulator]');
    if (!picker) return;
    const tpl = document.getElementById(picker.dataset.options);
    const opt = tpl && tpl.content.querySelector(`[data-value="${e.detail.value}"]`);
    if (!opt) return;
    document.querySelectorAll('[data-sim]').forEach((slot) => {
      const v = opt.dataset[slot.dataset.sim];
      if (v !== undefined) slot.textContent = v;
    });
  });

  // Daily report: the approve button counts checked agendas and is disabled at zero.
  const approve = document.querySelector('[data-approve]');
  if (approve) {
    const boxes = [...document.querySelectorAll('.agenda .check')];
    const count = approve.querySelector('[data-approve-count]');
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      count.textContent = String(n);
      approve.disabled = n === 0;
    };
    boxes.forEach((b) => b.addEventListener('change', sync));
    sync();
  }
})();
