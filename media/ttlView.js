(function () {
  const vscode = acquireVsCodeApi();

  const metaEl = document.getElementById('meta');
  const booksEl = document.getElementById('books');

  const RECORDS_PER_FILE = 20;
  const BOOK_NAME_MAX = 15; // field is 16 bytes, but 1 must be reserved for the null terminator

  let autoReloadEnabled = true;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function checksumBadge(label, info) {
    if (!info || info.valid === null) {
      return `<span class="badge new">${label}: new / unsaved</span>`;
    }
    return `<span class="badge ${info.valid ? 'ok' : 'warn'}">${label}: ${info.valid ? 'valid' : 'MISMATCH'}</span>`;
  }

  function render(state) {
    metaEl.innerHTML = `
      <div class="nav-row">
        <h2 class="ttl-title">${escapeHtml(state.fileName)}</h2>
        <label class="auto-reload-label">
          <input type="checkbox" id="autoReloadCheckbox" ${autoReloadEnabled ? 'checked' : ''} />
          Auto reload
        </label>
        ${state.isNew ? '<span class="badge new">unsaved new file</span>' : ''}
      </div>
      <div class="meta-row">
        <span>Version: <code>${state.meta.version}</code></span>
        <span>Group ID: <code>${state.meta.groupId}</code></span>
        ${checksumBadge('Checksum', state.checksumInfo)}
      </div>
      <p class="hint">Covers global books ${state.bookOffset + 1}\u2013${state.bookOffset + RECORDS_PER_FILE}. Renaming a book here updates it live in any already-open tab for that book too.</p>
    `;

    document.getElementById('autoReloadCheckbox').addEventListener('change', (e) => {
      autoReloadEnabled = e.target.checked;
      vscode.postMessage({ type: 'setAutoReload', value: autoReloadEnabled });
    });

    booksEl.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'book-list';

    state.names.forEach((name, index) => {
      const bookNumber = state.bookOffset + index + 1;
      const description = (state.descriptions && state.descriptions[index]) || '';

      const row = document.createElement('div');
      row.className = 'book-row';

      const top = document.createElement('div');
      top.className = 'book-row-top';

      const tag = document.createElement('span');
      tag.className = 'slot-badge book-tag';
      tag.textContent = `Book${pad2(bookNumber)}`;
      top.appendChild(tag);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'book-row-name';
      nameInput.maxLength = BOOK_NAME_MAX;
      nameInput.placeholder = '(unnamed book)';
      nameInput.value = name;
      nameInput.addEventListener('change', () => {
        vscode.postMessage({ type: 'editRecord', index, value: nameInput.value });
      });
      top.appendChild(nameInput);

      const viewButton = document.createElement('button');
      viewButton.className = 'view-button';
      viewButton.textContent = 'View';
      viewButton.title = `Open Book${pad2(bookNumber)} #1`;
      viewButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'viewBook', bookNumber });
      });
      top.appendChild(viewButton);

      row.appendChild(top);

      if (description) {
        const descEl = document.createElement('p');
        descEl.className = 'book-row-description';
        descEl.textContent = description;
        row.appendChild(descEl);
      }

      list.appendChild(row);
    });

    booksEl.appendChild(list);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'init') {
      render(message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
