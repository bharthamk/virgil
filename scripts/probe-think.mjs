const host = 'http://127.0.0.1:11434';
const call = async (model, think, num_predict) => {
  const t = Date.now();
  const r = await fetch(`${host}/api/chat`, { method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ model, stream: false, format: 'json',
      ...(think === null ? {} : { think }),
      options: { num_predict },
      messages: [
        { role: 'system', content: 'Label learning material. JSON only.' },
        { role: 'user', content: 'Passage: "Pub/Sub subscriptions can be pull or push."\nShort topic label (2-4 words). Return {"label": "..."}' },
      ] }) });
  const d = await r.json();
  const c = d.message?.content ?? '';
  const th = (d.message?.thinking ?? '').length;
  return `${String(Date.now()-t).padStart(6)}ms  eval=${String(d.eval_count??0).padStart(4)}  think_chars=${String(th).padStart(5)}  -> ${c.replace(/\s+/g,' ').slice(0,60)}`;
};
for (const model of ['gemma4:12b-mlx','qwen3.8:27b-mlx']) {
  for (const think of [null, false]) {
    process.stdout.write(`${model.padEnd(16)} think=${String(think).padEnd(5)} `);
    try { console.log(await call(model, think, 512)); } catch(e){ console.log('FAIL '+e.message.slice(0,80)); }
  }
}
