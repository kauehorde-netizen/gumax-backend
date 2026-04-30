// ═══ Gumax — WhatsApp Notifications ═══
// Dispara mensagens via API do WhatsApp em eventos chave do sistema.
//
// Suporta 2 providers (escolhido por env vars):
//   - WhatsApp Cloud API (Meta): WA_CLOUD_TOKEN + WA_CLOUD_PHONE_ID
//   - Z-API (alternativa BR popular): ZAPI_INSTANCE + ZAPI_TOKEN
//
// Se nenhum estiver configurado, faz NO-OP (loga e segue) — não derruba o
// fluxo principal. Eventos suportados:
//   - notifyOrderPaid(order)       — confirma pagamento pro cliente + admin
//   - notifyOrderShipped(order)    — entrega anunciada pro cliente
//   - notifyRaffleWinner(raffle, winner)  — vencedor de rifa
//   - notifyAdmin(text)            — alerta interno (admin do Gumax)

const ADMIN_NUMBER = process.env.GUMAX_ADMIN_WHATSAPP || ''; // E.164 sem '+', ex: '5521967298333'

// ── Provider: WhatsApp Cloud API (Meta) ───────────────────────────────────
async function sendViaCloud(toE164, text) {
  const TOKEN   = process.env.WA_CLOUD_TOKEN;
  const PHONEID = process.env.WA_CLOUD_PHONE_ID;
  if (!TOKEN || !PHONEID) return { sent: false, reason: 'cloud not configured' };
  const url = `https://graph.facebook.com/v18.0/${PHONEID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toE164,
    type: 'text',
    text: { body: text, preview_url: true },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('[WA Cloud] err:', r.status, JSON.stringify(data).slice(0, 200));
    return { sent: false, status: r.status, data };
  }
  return { sent: true, provider: 'cloud', messageId: data.messages?.[0]?.id };
}

// ── Provider: Z-API (popular no Brasil, simples) ──────────────────────────
async function sendViaZapi(toE164, text) {
  const INSTANCE = process.env.ZAPI_INSTANCE;
  const TOKEN    = process.env.ZAPI_TOKEN;
  const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!INSTANCE || !TOKEN) return { sent: false, reason: 'zapi not configured' };
  const url = `https://api.z-api.io/instances/${INSTANCE}/token/${TOKEN}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (CLIENT_TOKEN) headers['Client-Token'] = CLIENT_TOKEN;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: toE164, message: text }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('[Z-API] err:', r.status, JSON.stringify(data).slice(0, 200));
    return { sent: false, status: r.status, data };
  }
  return { sent: true, provider: 'zapi', messageId: data.id };
}

// Normaliza número pra E.164 sem '+': '+55 (21) 96729-8333' → '5521967298333'.
// Se já vier limpo, devolve igual. Se faltar DDI 55, adiciona (números BR).
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length >= 10) return '55' + digits; // assume BR
  return digits;
}

// Tenta cada provider na ordem; primeiro que conseguir manda. NO-OP se nenhum.
async function sendWhatsApp(rawPhone, text) {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    console.log('[WA notify] sem número — skip');
    return { sent: false, reason: 'no phone' };
  }
  // Cloud primeiro (oficial Meta), depois Z-API
  const tryers = [sendViaCloud, sendViaZapi];
  for (const fn of tryers) {
    const r = await fn(phone, text).catch(e => ({ sent: false, error: e.message }));
    if (r.sent) {
      console.log(`[WA notify] sent via ${r.provider} to ${phone}`);
      return r;
    }
  }
  console.log(`[WA notify] no provider configured — skip (number=${phone})`);
  return { sent: false, reason: 'no provider configured' };
}

// ── Helpers de evento ─────────────────────────────────────────────────────
function fmtBRL(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

async function notifyOrderPaid(order) {
  if (!order) return;
  const itemsText = (order.items || []).slice(0, 5).map(i => `• ${i.name || 'Skin'} (${i.qty || 1}x)`).join('\n');
  const more = (order.items?.length || 0) > 5 ? `\n…e mais ${order.items.length - 5}` : '';
  const txt =
`✅ *Pagamento confirmado — Gumax Skins*

Pedido: \`${order.orderId}\`
Total: ${fmtBRL(order.total)}
${itemsText}${more}

Sua skin será entregue em até *30 minutos* (Full) ou *12h* (Normal). Vou avisar aqui quando a trade for enviada. Se precisar de ajuda: gumaxskins.com/sac`;
  // Cliente
  const cli = await sendWhatsApp(order.user?.whatsapp, txt);
  // Admin
  if (ADMIN_NUMBER) {
    const admTxt = `🟢 Novo pedido PAGO\n${order.orderId}\n${fmtBRL(order.total)}\nCliente: ${order.user?.name || '?'}\n${order.user?.whatsapp || 'sem WhatsApp'}`;
    await sendWhatsApp(ADMIN_NUMBER, admTxt);
  }
  return cli;
}

async function notifyOrderShipped(order) {
  if (!order) return;
  const txt = `📦 *Skin enviada — Gumax Skins*

Pedido: \`${order.orderId}\`
Aceite a trade no Steam: https://steamcommunity.com/profiles/${order.user?.steamId || ''}/tradeoffers/

Caso a trade não chegue em 30min, me chama: gumaxskins.com/sac`;
  return sendWhatsApp(order.user?.whatsapp, txt);
}

async function notifyRaffleWinner(raffle, winner) {
  if (!winner?.whatsapp) return;
  const txt = `🎉 *VOCÊ GANHOU A RIFA — Gumax Skins!*

🎁 Prêmio: *${raffle.prizeName || 'Skin'}*
🎟️ Bilhete sorteado: #${winner.ticketNumber}

Em breve um atendente vai te chamar pra combinar a entrega via Trade Steam. Parabéns! 🚀`;
  // Avisa cliente
  const cli = await sendWhatsApp(winner.whatsapp, txt);
  // Avisa admin pra ele agir
  if (ADMIN_NUMBER) {
    await sendWhatsApp(ADMIN_NUMBER, `🏆 RIFA ${raffle.id || ''} sorteada\nVencedor: ${winner.name}\nWhatsApp: ${winner.whatsapp}\nPrêmio: ${raffle.prizeName}`);
  }
  return cli;
}

async function notifyAdmin(text) {
  if (!ADMIN_NUMBER) {
    console.log('[WA notify] admin number not set — skip');
    return { sent: false };
  }
  return sendWhatsApp(ADMIN_NUMBER, text);
}

module.exports = {
  sendWhatsApp,
  notifyOrderPaid,
  notifyOrderShipped,
  notifyRaffleWinner,
  notifyAdmin,
  normalizePhone,
};
