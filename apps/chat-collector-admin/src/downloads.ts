function csvCell(value: unknown) {
  const text =
    value == null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const safe =
    typeof value === 'string' && /^(?:\s*[=+\-@]|[\t\r\n])/.test(text)
      ? `'${text}`
      : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function toCsv(rows: readonly Record<string, unknown>[]) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0] ?? {});
  return `\uFEFF${[
    columns.map(csvCell).join(','),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(','),
    ),
  ].join('\r\n')}\r\n`;
}

export function downloadTimestamp(time: number) {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function saveFile(blob: Blob, filename: string) {
  // ponytail: browser downloads buffer the file; use a streaming file writer if exports outgrow memory.
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser start reading the object URL before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
