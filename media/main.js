(function () {
  const vscode = acquireVsCodeApi();

  const metaEl = document.getElementById('meta');
  const macrosEl = document.getElementById('macros');

  const BOOKS_PER_CHARACTER = 40;
  const SETS_PER_BOOK = 10;
  const MACRO_NAME_MAX = 8;   // in-game display limit
  const BOOK_NAME_MAX = 15;  // field is 16 bytes, but 1 must be reserved for the null terminator

  // Lives outside render() so it survives the frequent re-renders triggered
  // by tab-focus resync, sibling book-name propagation, and auto-reload.
  let autoReloadEnabled = true;
  let activeBar = 'ctrl'; // 'ctrl' | 'alt' - which bar's tab is currently shown
  let lastState = null; // cached so tab clicks can re-render without a round trip

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function bookOptionLabel(name, bookNumber) {
    const tag = `Book${pad2(bookNumber)}`;
    return name ? `${name} (${tag})` : `(${tag})`;
  }

  function checksumBadge(label, info) {
    if (!info || info.valid === null) {
      return `<span class="badge new">${label}: new / unsaved</span>`;
    }
    return `<span class="badge ${info.valid ? 'ok' : 'warn'}">${label}: ${info.valid ? 'valid' : 'MISMATCH'}</span>`;
  }

  function render(state) {
    lastState = state;
    const location = state.location; // {bookNumber, setNumber, fileIndex} or null

    // --- Book / set navigation dropdowns ---
    let bookSelectHtml = '';
    let setSelectHtml = '';
    if (location) {
      const bookOptions = [];
      for (let b = 1; b <= BOOKS_PER_CHARACTER; b++) {
        const name = state.allBookNames[b - 1] || '';
        const selected = b === location.bookNumber ? ' selected' : '';
        bookOptions.push(`<option value="${b}"${selected}>${escapeHtml(bookOptionLabel(name, b))}</option>`);
      }
      bookSelectHtml = `<select id="bookSelect">${bookOptions.join('')}</select>`;

      const setOptions = [];
      for (let s = 1; s <= SETS_PER_BOOK; s++) {
        const selected = s === location.setNumber ? ' selected' : '';
        setOptions.push(`<option value="${s}"${selected}>#${s}</option>`);
      }
      setSelectHtml = `<select id="setSelect">${setOptions.join('')}</select>`;
    }

    metaEl.innerHTML = `
      <div class="nav-row">
        ${bookSelectHtml}
        ${setSelectHtml}
        <label class="auto-reload-label">
          <input type="checkbox" id="autoReloadCheckbox" ${autoReloadEnabled ? 'checked' : ''} />
          Auto reload
        </label>
        ${state.isNew ? '<span class="badge new">unsaved new set</span>' : ''}
      </div>
      <div class="book-name-row">
        <label for="bookNameInput">Book name</label>
        <input id="bookNameInput" type="text" maxlength="${BOOK_NAME_MAX}" placeholder="(unnamed book)" value="${escapeAttr(state.bookName)}" />
      </div>
      ${state.bookDescription ? `<p class="book-description">${escapeHtml(state.bookDescription)}</p>` : ''}
      <h2>${escapeHtml(state.fileName)}</h2>
      <div class="meta-row">
        <span>Version: <code>${state.meta.version}</code></span>
        <span>Group ID: <code>${state.meta.groupId}</code></span>
        ${checksumBadge('Macro set checksum', state.checksumInfo)}
        ${checksumBadge('Book name checksum', state.ttlChecksumInfo)}
      </div>
      <p class="hint">Edits are recalculated and re-checksummed automatically when you save (Ctrl+S). Auto reload picks up changes the running game client writes to disk, but pauses itself while this tab has unsaved edits.</p>
    `;

    if (location) {
      document.getElementById('bookSelect').addEventListener('change', (e) => {
        vscode.postMessage({
          type: 'navigate',
          bookNumber: parseInt(e.target.value, 10),
          setNumber: 1 // switching books always jumps to set #1 of the new book
        });
      });
      document.getElementById('setSelect').addEventListener('change', (e) => {
        vscode.postMessage({
          type: 'navigate',
          bookNumber: location.bookNumber,
          setNumber: parseInt(e.target.value, 10)
        });
      });
    }

    document.getElementById('autoReloadCheckbox').addEventListener('change', (e) => {
      autoReloadEnabled = e.target.checked;
      vscode.postMessage({ type: 'setAutoReload', value: autoReloadEnabled });
    });

    const bookNameInput = document.getElementById('bookNameInput');
    bookNameInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'editBookName', value: bookNameInput.value });
      // Keep the dropdown option text in sync without waiting for a round trip.
      if (location) {
        const opt = document.querySelector(`#bookSelect option[value="${location.bookNumber}"]`);
        if (opt) {
          opt.textContent = bookOptionLabel(bookNameInput.value, location.bookNumber);
        }
      }
    });

    // --- Ctrl/Alt bar tabs + macro cards ---
    macrosEl.innerHTML = `
      <div class="bar-tabs">
        <button type="button" class="bar-tab${activeBar === 'ctrl' ? ' active' : ''}" data-bar="ctrl">Ctrl Bar</button>
        <button type="button" class="bar-tab${activeBar === 'alt' ? ' active' : ''}" data-bar="alt">Alt Bar</button>
      </div>
      ${(() => {
        const desc = activeBar === 'ctrl' ? state.ctrlDescription : state.altDescription;
        return desc ? `<p class="group-description">${escapeHtml(desc)}</p>` : '';
      })()}
    `;

    macrosEl.querySelectorAll('.bar-tab').forEach((tabButton) => {
      tabButton.addEventListener('click', () => {
        if (activeBar === tabButton.dataset.bar) {
          return;
        }
        activeBar = tabButton.dataset.bar;
        render(lastState);
      });
    });

    const startIndex = activeBar === 'ctrl' ? 0 : 10;
    for (let index = startIndex; index < startIndex + 10; index++) {
      const macro = state.macros[index];

      const card = document.createElement('div');
      card.className = 'macro-card';

      const header = document.createElement('div');
      header.className = 'macro-card-header';

      const slotBadge = document.createElement('span');
      slotBadge.className = 'slot-badge';
      slotBadge.textContent = macro.slot;
      header.appendChild(slotBadge);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'macro-name';
      nameInput.maxLength = MACRO_NAME_MAX;
      nameInput.placeholder = 'Macro name';
      nameInput.value = macro.name;
      nameInput.addEventListener('change', () => {
        vscode.postMessage({ type: 'edit', index, field: 'name', value: nameInput.value });
      });
      header.appendChild(nameInput);

      card.appendChild(header);

      const linesWrap = document.createElement('div');
      linesWrap.className = 'lines';
      macro.lines.forEach((line, lineIndex) => {
        const lineRow = document.createElement('div');
        lineRow.className = 'macro-line-row';

        const lineInput = document.createElement('input');
        lineInput.type = 'text';
        lineInput.className = 'macro-line';
        lineInput.maxLength = 60;
        lineInput.placeholder = `Line ${lineIndex + 1}`;
        lineInput.value = line;

        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'open-script-button';
        openButton.textContent = 'Open';

        const syncExecState = () => {
          const scriptName = execScriptName(lineInput.value);
          if (scriptName) {
            openButton.style.display = 'inline-block';
            openButton.title = `Open ${scriptName}.txt`;
            openButton.onclick = () => {
              vscode.postMessage({ type: 'openExecScript', scriptName });
            };
          } else {
            openButton.style.display = 'none';
            openButton.onclick = null;
          }
        };

        lineInput.addEventListener('input', syncExecState);
        lineInput.addEventListener('change', () => {
          vscode.postMessage({
            type: 'edit',
            index,
            field: 'line',
            lineIndex,
            value: lineInput.value
          });
        });
        syncExecState();

        lineRow.appendChild(lineInput);
        lineRow.appendChild(openButton);
        linesWrap.appendChild(lineRow);
      });
      card.appendChild(linesWrap);

      macrosEl.appendChild(card);
    }
  }

  /** Detect an "/exec <name>" macro line, returning the script base name (no .txt), or null. */
  function execScriptName(line) {
    const match = /^\s*\/exec\s+(\S+)/i.exec(line || '');
    if (!match) {
      return null;
    }
    return match[1].replace(/\.txt$/i, '');
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(str) {
    return escapeHtml(str);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'init') {
      render(message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
