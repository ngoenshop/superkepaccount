// netlify/functions/buy.js
const admin = require('firebase-admin');
if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const TS = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (code, error) => ({ statusCode: code, body: JSON.stringify({ error }) });

exports.handler = async (ev) => {
  if (ev.httpMethod !== 'POST') return bad(405, 'method');
  let uid, email;
  try {
    const tok = (ev.headers.authorization || '').replace('Bearer ', '');
    const d = await admin.auth().verifyIdToken(tok); uid = d.uid; email = d.email || '';
  } catch (e) { return bad(401, 'กรุณาเข้าสู่ระบบใหม่'); }

  let items = {};
  try { items = JSON.parse(ev.body || '{}').items || {}; } catch (e) {}
  const list = Object.entries(items).map(([pid, q]) => [pid, Math.max(0, Math.floor(+q || 0))]).filter(([, q]) => q > 0);
  if (!list.length) return bad(400, 'ตะกร้าว่าง');
  if (list.reduce((a, [, q]) => a + q, 0) > 20) return bad(400, 'ซื้อได้ครั้งละไม่เกิน 20 ชิ้น');

  const ban = await db.doc('banned/' + uid).get();
  if (ban.exists) return bad(403, 'บัญชีนี้ถูกระงับการซื้อ');

  try {
    const result = await db.runTransaction(async (tx) => {
      const uRef = db.doc('users/' + uid);
      const uSnap = await tx.get(uRef);
      if (!uSnap.exists) throw new Error('ไม่พบข้อมูลสมาชิก');
      const u = uSnap.data(); const reseller = u.role === 'reseller';

      const prods = []; let total = 0; const stockDocs = [];
      for (const [pid, q] of list) {
        const pSnap = await tx.get(db.doc('products/' + pid));
        if (!pSnap.exists) throw new Error('ไม่พบสินค้า');
        const p = pSnap.data(); const price = Number(reseller ? p.r : p.p) || 0;
        const st = await tx.get(db.collection('stock').where('pid', '==', pid).limit(q));
        if (st.size < q) throw new Error(`สินค้า "${p.n}" เหลือไม่พอ (เหลือ ${st.size} ชิ้น)`);
        prods.push({ pid, q, p, price }); total += price * q; stockDocs.push(st.docs);
      }
      if ((u.credit || 0) < total) throw new Error(`เครดิตไม่พอ ต้องใช้ ฿${total} มี ฿${u.credit || 0}`);

      tx.update(uRef, { credit: admin.firestore.FieldValue.increment(-total) });
      const orders = [];
      prods.forEach(({ pid, q, p, price }, i) => {
        stockDocs[i].forEach((sd) => {
          const s = sd.data(); const oRef = db.collection('orders').doc();
          tx.set(oRef, { uid, email, pid, pname: p.n, paid: price, q: 1, u: s.u || '', pw: s.pw || '', t: TS() });
          tx.delete(sd.ref); orders.push(oRef.id);
        });
        tx.update(db.doc('products/' + pid), { stockCount: admin.firestore.FieldValue.increment(-q) });
      });
      tx.set(db.collection('topups').doc(), { uid, email, a: -total, by: 'ซื้อ ' + prods.map(x => `${x.p.n}×${x.q}`).join(', '), t: TS() });
      tx.set(db.collection('notis').doc(), { msg: `${u.name || email} ซื้อ ${prods.map(x => `${x.p.n}×${x.q}`).join(', ')} ฿${total}`.slice(0, 190), go: 'ord', read: false, t: TS() });
      return { total, orders };
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (e) {
    return bad(400, e.message || 'สั่งซื้อไม่สำเร็จ');
  }
};
