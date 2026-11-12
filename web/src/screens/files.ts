import { api } from '../lib/api';

export const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const ACCEPT = Object.keys(TYPES).map((e) => `.${e}`).join(',');

/** Uploads one file as a raw body; the server checks the real signature. */
export async function uploadFile(org: string, number: number, f: File) {
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  const type = TYPES[ext] ?? f.type;
  if (!type || !Object.values(TYPES).includes(type)) throw new Error('Этот тип файла не поддерживается');
  if (f.size > 5 * 1024 * 1024) throw new Error('Файл больше 5 МБ');
  return api(`/orgs/${org}/ideas/${number}/attachments`, {
    method: 'POST',
    body: await f.arrayBuffer(),
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(f.name) },
  });
}

/** Downloads with the session token (links cannot carry the Authorization header). */
export async function downloadFile(org: string, number: number, id: string, name: string) {
  const { getToken } = await import('../lib/api');
  const res = await fetch(`/api/v1/orgs/${org}/ideas/${number}/attachments/${id}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('Не удалось скачать файл');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
