// Дела «после ответа»: Supabase доделывает их, когда Telegram уже получил ответ,
// поэтому пользователь не ждёт (удаление старых сообщений, выгрузка на сайт).
const pending: Promise<unknown>[] = [];

export function background(job: Promise<unknown>) {
  const safe = job.catch((e) => console.log(`Фоновая задача: ${(e as Error).message}`));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe);
  else pending.push(safe); // локально (тесты) — дождёмся в flush()
}

/** Дождаться фоновых дел (нужно только вне Supabase — в тестах). */
export async function flush() {
  while (pending.length) await Promise.all(pending.splice(0));
}
