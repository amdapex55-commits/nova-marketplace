/* Bag, checkout and order confirmation.
 *
 * The shape of this screen is set by one fact: an order can contain items from
 * several sellers, and each seller ships their own parcel and collects their
 * own money. So the buyer is not making one purchase — they are making one
 * decision that becomes several shipments, and the checkout has to say so
 * plainly, before they pay, rather than surprising them with three riders.
 *
 * Nova never holds the money. Sellers pay a subscription; cash on delivery goes
 * from the buyer straight to the seller's rider. That keeps us out of escrow,
 * refunds and payment licensing entirely — and it is the reason the summary
 * below is grouped by seller rather than showing one flat total.
 */
import { api } from './api.js';
import { store } from './store.js';
import { el, esc, ICON, money, toast } from './ui.js';
import { priceOrder, normalisePhone, prettyPhone, orderCode, RULES } from './money.mjs';
import { statusRail } from './motion.js';

const lineFrom = p => ({ id: p.id, seller_id: p.seller_id, title: p.title, price: p.price, photo: p.photos[0], city: p.city, brand: p.seller.brand_name });

async function bagLines() {
  const bag = store.get().bag;
  const products = await api.products(bag.map(l => l.id));
  return bag
    .map(l => { const p = products.find(x => x.id === l.id); return p ? { ...lineFrom(p), qty: l.qty, stock: p.stock } : null; })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ the bag */
export async function bagScreen({ onOpen, onCheckout }) {
  const lines = await bagLines();
  const root = el(`
    <div class="screen">
      <div class="top">
        <h1>Your bag</h1>
        <a class="btn ghost" href="#/orders" style="min-height:36px;padding:0 13px;font-size:14px">Orders</a>
      </div>
      <div class="scroll" id="body"></div>
    </div>`);
  const body = root.querySelector('#body');

  if (!lines.length) {
    body.append(el(`
      <div class="empty">
        <h2>Your bag is empty</h2>
        <p>Everything you add stays here on this device. No account needed until you order.</p>
        <a class="btn ghost" href="#/orders">Find a past order</a>
      </div>`));
    return root;
  }

  const sellers = await api.sellers();
  const priced = priceOrder({ lines, sellers, buyerCity: store.get().contact?.city || null });

  for (const sh of priced.shipments) {
    const group = el(`
      <div class="group">
        <header>
          <h2>${esc(sh.seller.brand_name)}</h2>
          <span class="note">Ships from ${esc(sh.seller.city)}</span>
        </header>
      </div>`);
    for (const l of sh.lines) {
      const row = el(`
        <div class="line">
          <div class="ph"><img src="${esc(l.photo)}" alt="" loading="lazy"></div>
          <div>
            <h3>${esc(l.title)}</h3>
            <div class="sub num">${money(l.price)} each${l.stock <= 3 ? ` · only ${l.stock} left` : ''}</div>
            <div class="stepper">
              <button aria-label="Fewer" ${l.qty <= 1 ? 'disabled' : ''}>&minus;</button>
              <span class="num">${l.qty}</span>
              <button aria-label="More" ${l.qty >= Math.min(RULES.MAX_QTY_PER_LINE, l.stock) ? 'disabled' : ''}>+</button>
            </div>
            <div><button class="rm">Remove</button></div>
          </div>
          <div class="price num">${money(l.price * l.qty)}</div>
        </div>`);
      const [minus, plus] = row.querySelectorAll('.stepper button');
      minus.addEventListener('click', () => { store.setQty(l.id, l.qty - 1); onCheckout.refresh(); });
      plus.addEventListener('click', () => { store.setQty(l.id, l.qty + 1); onCheckout.refresh(); });
      row.querySelector('.rm').addEventListener('click', () => { store.removeFromBag(l.id); toast('Removed'); onCheckout.refresh(); });
      row.querySelector('.ph').addEventListener('click', () => onOpen(l.id));
      group.append(row);
    }
    body.append(group);
  }

  body.append(el(`
    <div class="notice info">
      ${ICON.truck}
      <div>${priced.shipments.length === 1
        ? 'One seller, one parcel. Delivery is worked out at checkout once we know your city.'
        : `<b>${priced.shipments.length} sellers</b> means ${priced.shipments.length} separate parcels, each with its own delivery charge. They may arrive on different days.`}</div>
    </div>`));

  const total = el(`
    <div class="group">
      <div class="totals">
        <div class="r"><span>Items (${priced.units})</span><b class="num">${money(priced.items)}</b></div>
        <div class="r"><span>Delivery</span><b>Worked out at checkout</b></div>
      </div>
    </div>`);
  body.append(total);

  const go = el('<div class="pad" style="padding-bottom:20px"><button class="btn block">Checkout</button></div>');
  go.querySelector('button').addEventListener('click', () => onCheckout.go());
  body.append(go);

  return root;
}

/* ----------------------------------------------------------------- checkout */
export async function checkoutScreen({ onBack, onPlaced }) {
  const lines = await bagLines();
  if (!lines.length) { onBack(); return el('<div class="screen"></div>'); }
  const sellers = await api.sellers();
  const saved = store.get().contact || {};

  const form = {
    name: saved.name || '',
    phone: saved.phone || '',
    city: saved.city || '',
    area: saved.area || '',
    address: saved.address || '',
    landmark: saved.landmark || '',
    notes: '',
    express: false,
    payment: 'cod'
  };
  const errors = {};

  const root = el(`
    <div class="screen">
      <div class="top">
        <button class="back" aria-label="Back to bag">${ICON.back}</button>
        <h1>Checkout</h1>
      </div>
      <div class="scroll" id="body"></div>
      <div class="sticky-buy" id="foot"></div>
    </div>`);
  root.querySelector('.back').addEventListener('click', onBack);
  const body = root.querySelector('#body');
  const foot = root.querySelector('#foot');

  const field = (key, label, { type = 'text', hint = '', placeholder = '', inputmode, autocomplete, textarea = false, options } = {}) => {
    const id = 'f-' + key;
    const node = el(`
      <div class="field${errors[key] ? ' bad' : ''}">
        <label for="${id}">${esc(label)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</label>
        ${options
          ? `<select id="${id}"><option value="">Select your city</option>${options.map(o => `<option value="${esc(o)}"${form[key] === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : textarea
            ? `<textarea id="${id}" placeholder="${esc(placeholder)}">${esc(form[key])}</textarea>`
            : `<input id="${id}" type="${type}" value="${esc(form[key])}" placeholder="${esc(placeholder)}"${inputmode ? ` inputmode="${inputmode}"` : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''}>`}
        ${errors[key] ? `<div class="err" role="alert">${esc(errors[key])}</div>` : ''}
      </div>`);
    const input = node.querySelector('input, select, textarea');
    input.addEventListener('input', () => {
      form[key] = input.value;
      // Clear this field's error as soon as it passes — in place, because a
      // re-render here would take the focus out of the field being typed in.
      if (errors[key] && !CHECKS[key]?.(form[key])) {
        delete errors[key];
        node.classList.remove('bad');
        node.querySelector('.err')?.remove();
      }
      // The city changes delivery pricing, so the summary has to move with it.
      if (key === 'city') render();
    });
    return node;
  };

  function totals() {
    return priceOrder({ lines, sellers, buyerCity: form.city || null, express: form.express });
  }

  function render() {
    const priced = totals();
    const codBlocked = !priced.codAllowed;
    if (codBlocked && form.payment === 'cod') form.payment = 'transfer';

    body.replaceChildren();

    /* --- contact --- */
    const contact = el('<div class="group"><header><h2>Who is this for?</h2></header><div class="inner"></div></div>');
    contact.querySelector('.inner').append(
      field('name', 'Full name', { autocomplete: 'name', placeholder: 'As the rider should ask for' }),
      field('phone', 'Mobile number', { hint: 'the rider will call this', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0300 1234567' })
    );
    body.append(contact);

    /* --- address --- */
    const addr = el('<div class="group"><header><h2>Where should it go?</h2></header><div class="inner"></div></div>');
    addr.querySelector('.inner').append(
      field('city', 'City', { options: window.NOVAMKT.CITIES }),
      field('area', 'Area or town', { placeholder: 'DHA Phase 5, Gulberg III…' }),
      field('address', 'Full address', { textarea: true, placeholder: 'House / flat number, street, block' }),
      field('landmark', 'Nearest landmark', { hint: 'optional, but riders find you faster', placeholder: 'Opposite the park, above the pharmacy…' }),
      field('notes', 'Note for the seller', { hint: 'optional', textarea: true, placeholder: 'Size, colour, a delivery time that suits you' })
    );
    body.append(addr);

    /* --- speed --- */
    const speed = el('<div class="group"><header><h2>Delivery speed</h2></header><div class="inner"></div></div>');
    // Both prices are shown at once, so choosing express is a comparison rather
    // than a surprise after the fact.
    const standardFee = form.city ? priceOrder({ lines, sellers, buyerCity: form.city, express: false }).delivery : null;
    const expressFee  = form.city ? priceOrder({ lines, sellers, buyerCity: form.city, express: true }).delivery : null;
    for (const [val, title, sub, tail] of [
      [false, 'Standard', form.city ? '2–4 working days' : 'Pick your city to see the charge', standardFee === null ? '—' : (standardFee === 0 ? 'Free' : money(standardFee))],
      [true, 'Express', '1–2 working days where the seller offers it', expressFee === null ? '—' : money(expressFee)]
    ]) {
      const opt = el(`
        <button class="opt" role="radio" aria-checked="${form.express === val}">
          <span class="mark"><i></i></span>
          <span><b>${title}</b><span>${esc(sub)}</span></span>
          <span class="tail num">${esc(tail)}</span>
        </button>`);
      opt.addEventListener('click', () => { form.express = val; render(); });
      speed.querySelector('.inner').append(opt);
    }
    body.append(speed);

    /* --- payment --- */
    const pay = el('<div class="group"><header><h2>Payment</h2><span class="note">paid to the seller</span></header><div class="inner"></div></div>');
    const cod = el(`
      <button class="opt" role="radio" aria-checked="${form.payment === 'cod'}" ${codBlocked ? 'disabled' : ''}>
        <span class="mark"><i></i></span>
        <span><b>Cash on delivery</b><span>${codBlocked
          ? `Not available above ${money(RULES.COD_LIMIT)} — riders cannot carry it`
          : 'Pay the rider when your parcel arrives. Check it at the door.'}</span></span>
      </button>`);
    cod.addEventListener('click', () => { if (!codBlocked) { form.payment = 'cod'; render(); } });

    const transfer = el(`
      <button class="opt" role="radio" aria-checked="${form.payment === 'transfer'}">
        <span class="mark"><i></i></span>
        <span><b>Bank transfer or JazzCash</b><span>The seller sends account details after you order. They ship once it clears.</span></span>
      </button>`);
    transfer.addEventListener('click', () => { form.payment = 'transfer'; render(); });
    pay.querySelector('.inner').append(cod, transfer);
    body.append(pay);

    if (codBlocked) body.append(el(`
      <div class="notice warn"><div>This order is over ${money(RULES.COD_LIMIT)}, so it has to be prepaid. Split it into two orders if you would rather pay cash.</div></div>`));

    /* --- summary, grouped the way it will actually be delivered --- */
    const sum = el(`<div class="group"><header><h2>Your order</h2><span class="note">${priced.shipments.length} ${priced.shipments.length === 1 ? 'parcel' : 'parcels'}</span></header></div>`);
    for (const sh of priced.shipments) {
      sum.append(el(`
        <div class="ship">
          <div class="hd"><b>${esc(sh.seller.brand_name)}</b><span>${esc(sh.seller.city)}${form.city ? (sh.sameCity ? ' · same city' : ' · other city') : ''}</span></div>
          <ul>
            ${sh.lines.map(l => `<li><span>${esc(l.title)} × ${l.qty}</span><span class="num">${money(l.price * l.qty)}</span></li>`).join('')}
            <li><span>${sh.freeDelivery && !form.express ? 'Delivery (free over ' + money(RULES.FREE_DELIVERY_OVER) + ')' : 'Delivery'}</span><span class="num">${form.city ? money(sh.delivery) : '—'}</span></li>
          </ul>
        </div>`));
    }
    sum.append(el(`
      <div class="totals">
        <div class="r"><span>Items (${priced.units})</span><b class="num">${money(priced.items)}</b></div>
        <div class="r${priced.delivery === 0 && form.city ? ' free' : ''}"><span>Delivery</span><b class="num">${form.city ? (priced.delivery === 0 ? 'Free' : money(priced.delivery)) : 'Pick your city'}</b></div>
        <div class="r grand"><span>${form.payment === 'cod' ? 'To pay on delivery' : 'To transfer'}</span><b class="num">${form.city ? money(priced.total) : money(priced.items) + '+'}</b></div>
      </div>`));
    body.append(sum);

    body.append(el(`
      <div class="notice info"><div>Nova never holds your money. You pay each seller directly, and each parcel is dispatched by the seller who made it.</div></div>`));

    /* --- footer --- */
    foot.replaceChildren();
    const place = el(`<button class="btn block">Place order · <span class="num">${form.city ? money(priced.total) : money(priced.items) + '+'}</span></button>`);
    place.addEventListener('click', submit);
    foot.append(place);
  }

  /* One check per field, so a field can be re-checked on its own the moment the
     buyer corrects it. An error that stays red after it has been fixed is worse
     than no error at all — it tells them the form is broken. */
  const CHECKS = {
    name:    v => v.trim().length >= 3 ? null : 'We need a name for the rider to ask for.',
    phone:   v => normalisePhone(v) ? null : 'Enter a Pakistani mobile number, like 0300 1234567.',
    city:    v => v ? null : 'Pick your city — delivery is priced on it.',
    area:    v => v.trim() ? null : 'Which area of the city?',
    address: v => v.trim().length >= 10 ? null : 'Add the house or flat number and the street.'
  };

  function validate() {
    for (const k of Object.keys(errors)) delete errors[k];
    for (const [k, check] of Object.entries(CHECKS)) {
      const msg = check(form[k]);
      if (msg) errors[k] = msg;
    }
    return Object.keys(errors).length === 0;
  }

  async function submit() {
    if (!validate()) {
      render();
      const bad = body.querySelector('.field.bad input, .field.bad select, .field.bad textarea');
      bad?.focus();
      bad?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast('Check the highlighted fields');
      return;
    }

    const priced = totals();
    const order = {
      code: orderCode(),
      placed_at: new Date().toISOString(),
      // The prices are snapshotted here so the confirmation can never disagree
      // with what was agreed. The live version re-reads them server-side before
      // writing: a price that arrived from a browser is a price an attacker
      // chose.
      contact: {
        name: form.name.trim(),
        phone: normalisePhone(form.phone),
        city: form.city,
        area: form.area.trim(),
        address: form.address.trim(),
        landmark: form.landmark.trim(),
        notes: form.notes.trim()
      },
      express: form.express,
      payment: form.payment,
      totals: { items: priced.items, delivery: priced.delivery, total: priced.total, units: priced.units },
      shipments: priced.shipments.map(sh => ({
        seller_id: sh.seller_id,
        seller: sh.seller.brand_name,
        from: sh.seller.city,
        lines: sh.lines.map(l => ({ id: l.id, title: l.title, price: l.price, qty: l.qty })),
        items: sh.items,
        delivery: sh.delivery,
        total: sh.total,
        // Written on the order, not assumed later: whoever ships it, collects
        // for it. Nova is never in the payment path.
        collected_by: 'seller'
      }))
    };

    try {
      await api.placeOrder(order);
    } catch (err) {
      toast('Could not place the order — try again');
      console.error(err);
      return;
    }

    const { notes, ...keep } = form;
    store.rememberContact({ ...keep, phone: normalisePhone(form.phone) });
    store.recordOrder({ code: order.code, placed_at: order.placed_at, total: order.totals.total });
    store.clearBag();
    onPlaced(order.code);
  }

  render();
  return root;
}

/* ------------------------------------------------------- orders on this device */
/* A buyer with no account still has to be able to find an order they placed.
   Two routes in: the codes this device remembers, and — for a different phone
   or a cleared browser — a lookup that needs the code AND the number it was
   placed with, exactly as get_order() enforces server-side. */
export async function ordersScreen({ onOpen }) {
  const mine = store.get().orders;
  const root = el(`
    <div class="screen">
      <div class="top"><h1>Your orders</h1></div>
      <div class="scroll" id="body"></div>
    </div>`);
  const body = root.querySelector('#body');

  if (mine.length) {
    const list = el('<div class="group"><header><h2>Placed on this device</h2></header></div>');
    for (const o of mine) {
      const row = el(`
        <button class="ship" style="width:100%;text-align:left">
          <div class="hd"><b>${esc(o.code)}</b><span class="num">${money(o.total)}</span></div>
          <ul><li><span>${new Date(o.placed_at).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>View</span></li></ul>
        </button>`);
      row.addEventListener('click', () => onOpen(o.code));
      list.append(row);
    }
    body.append(list);
  } else {
    body.append(el(`
      <div class="empty">
        <h2>No orders yet</h2>
        <p>Anything you order shows up here. If you ordered from another phone, look it up below.</p>
      </div>`));
  }

  const look = el(`
    <div class="group">
      <header><h2>Find an order</h2><span class="note">code + phone</span></header>
      <div class="inner">
        <div class="field">
          <label for="lk-code">Order code</label>
          <input id="lk-code" placeholder="NM-XXXXXX" autocomplete="off" spellcheck="false" style="text-transform:uppercase">
        </div>
        <div class="field">
          <label for="lk-phone">Mobile number it was placed with</label>
          <input id="lk-phone" type="tel" inputmode="tel" placeholder="0300 1234567">
        </div>
        <button class="btn block" id="lk-go">Find it</button>
        <div class="err" id="lk-err" role="alert" hidden></div>
      </div>
    </div>`);
  const err = look.querySelector('#lk-err');
  look.querySelector('#lk-go').addEventListener('click', async () => {
    err.hidden = true;
    const code = look.querySelector('#lk-code').value.trim().toUpperCase();
    const phone = normalisePhone(look.querySelector('#lk-phone').value);
    if (!code || !phone) {
      err.hidden = false;
      err.textContent = 'Both the code and the number are needed.';
      return;
    }
    const found = await api.order(code, phone);
    if (!found) {
      // One message for "no such code" and "wrong number" on purpose: telling
      // someone a code exists but the phone is wrong turns the lookup into a
      // way to confirm that a stranger's order is real.
      err.hidden = false;
      err.textContent = 'No order matches that code and number.';
      return;
    }
    onOpen(found.code);
  });
  body.append(look);

  return root;
}

/* ------------------------------------------------------------- confirmation */
export async function orderScreen({ code, onHome, onOrders }) {
  const order = await api.order(code);
  if (!order) return el('<div class="screen"><div class="empty"><h2>We cannot find that order</h2><p>Check the code, or the phone number it was placed with.</p></div></div>');

  const root = el(`
    <div class="screen">
      <div class="scroll">
        <div class="done">
          <div class="tick">${ICON.tick}</div>
          <h1>Order placed</h1>
          <div class="code">${esc(order.code)}</div>
          <p>Keep this code. Each seller will call ${esc(prettyPhone(order.contact.phone))} to confirm before they dispatch.</p>
        </div>
      </div>
    </div>`);
  const scroll = root.querySelector('.scroll');

  const ship = el(`
    <div class="group" style="margin-top:18px">
      <header><h2>${order.shipments.length} ${order.shipments.length === 1 ? 'parcel' : 'parcels'}</h2><span class="note">${order.express ? 'Express' : 'Standard'}</span></header>
    </div>`);
  for (const sh of order.shipments) {
    const row = el(`
      <div class="ship">
        <div class="hd"><b>${esc(sh.seller)}</b><span class="num">${money(sh.total)}</span></div>
        <ul>
          ${sh.lines.map(l => `<li><span>${esc(l.title)} × ${l.qty}</span><span class="num">${money(l.price * l.qty)}</span></li>`).join('')}
          <li><span>Delivery from ${esc(sh.from)}</span><span class="num">${sh.delivery === 0 ? 'Free' : money(sh.delivery)}</span></li>
        </ul>
      </div>`);
    // The same rail the seller sees in their inbox, so the two can never
    // disagree about where a parcel has got to.
    row.append(statusRail(sh.status || 'placed'));
    ship.append(row);
  }
  ship.append(el(`
    <div class="totals">
      <div class="r grand"><span>${order.payment === 'cod' ? 'Pay each rider on delivery' : 'To transfer to each seller'}</span><b class="num">${money(order.totals.total)}</b></div>
    </div>`));
  scroll.append(ship);

  scroll.append(el(`
    <div class="group">
      <header><h2>Delivering to</h2></header>
      <div class="inner" style="gap:4px">
        <div><b>${esc(order.contact.name)}</b></div>
        <div style="color:var(--ink-soft)">${esc(order.contact.address)}, ${esc(order.contact.area)}, ${esc(order.contact.city)}</div>
        ${order.contact.landmark ? `<div style="color:var(--ink-faint);font-size:13px">Landmark: ${esc(order.contact.landmark)}</div>` : ''}
        <div style="color:var(--ink-soft)" class="num">${esc(prettyPhone(order.contact.phone))}</div>
        ${order.contact.notes ? `<div style="color:var(--ink-faint);font-size:13px">Note: ${esc(order.contact.notes)}</div>` : ''}
      </div>
    </div>`));

  scroll.append(el(`
    <div class="notice ${order.payment === 'cod' ? 'info' : 'warn'}">
      <div>${order.payment === 'cod'
        ? 'Cash on delivery. Open the parcel at the door and check it before you pay the rider.'
        : 'Each seller will message you their account details. Nothing ships until your transfer clears — never send money to anyone who contacts you from a different number.'}</div>
    </div>`));

  const foot = el(`
    <div class="pad" style="padding-bottom:24px;display:flex;flex-direction:column;gap:10px">
      <button class="btn block" id="keep-going">Keep browsing</button>
      <button class="btn ghost block" id="all-orders">All your orders</button>
    </div>`);
  foot.querySelector('#keep-going').addEventListener('click', onHome);
  foot.querySelector('#all-orders').addEventListener('click', onOrders);
  scroll.append(foot);

  return root;
}
