"use strict";

// Pruebas automáticas con un Firestore y un Mercado Pago simulados.
// Ejecutar con:  npm test

const assert = require("assert");
const crypto = require("crypto");

process.env.GCP_PROJECT_ID = "zeka-sorteo";
process.env.MP_ACCESS_TOKEN = "test-token";
process.env.MP_WEBHOOK_SECRET = "secreto-de-prueba";

const google = require("../lib/google");

// Se reemplazan las funciones que hablarían con Google antes de cargar la API.
let adminResult = { valid: true, uid: google.ADMIN_UID };
let currentUid = "U1";

google.getGoogleAccessToken = async () => "token-de-prueba";
google.verifyAdmin = async () => adminResult;
google.lookupUser = async () => currentUid;

const { processReservation } = require("../lib/payments");
const closeRaffle = require("../api/close-raffle");
const drawRaffle = require("../api/draw-raffle");
const createOrder = require("../api/create-order");
const reportPayment = require("../api/report-payment");
const confirmPayment = require("../api/confirm-payment");
const webhook = require("../api/mercadopago-webhook");

const DOCS = google.DOCS;
const PREFIX = "https://firestore.googleapis.com/v1/";

// ---------- Firestore simulado ----------

const store = new Map();
let clock = 1;
let rollbacks = 0;
let mpOrdersCreated = 0;
let mpOrder = null;

const S = value => ({ stringValue: value });
const N = value => ({ integerValue: String(value) });
const B = value => ({ booleanValue: value });
const T = ms => ({ timestampValue: new Date(ms).toISOString() });
const A = list => ({ arrayValue: { values: list.map(S) } });

function put(path, fields) {
  store.set(`${DOCS}/${path}`, { fields, updateTime: String(clock++) });
}

function read(path) {
  return store.get(`${DOCS}/${path}`)?.fields;
}

function applyWrite(write) {
  const { name, fields = {} } = write.update;

  if (!name.startsWith("projects/")) {
    throw new Error("Nombre de recurso inválido: " + name);
  }

  const existing = store.get(name);

  if (write.currentDocument?.exists && !existing) {
    throw new Error("El documento no existe: " + name);
  }

  if (
    write.currentDocument?.updateTime &&
    existing?.updateTime !== write.currentDocument.updateTime
  ) {
    throw new Error("El documento cambió: " + name);
  }

  const next = { ...(existing?.fields || {}) };

  if (write.updateMask) {
    for (const path of write.updateMask.fieldPaths) {
      if (path in fields) next[path] = fields[path];
      else delete next[path];
    }
  } else {
    Object.keys(next).forEach(key => delete next[key]);
    Object.assign(next, fields);
  }

  store.set(name, { fields: next, updateTime: String(clock++) });
}

function matches(fields, filter) {
  if (filter.compositeFilter) {
    return filter.compositeFilter.filters.every(f => matches(fields, f));
  }

  const { field, value } = filter.fieldFilter;

  return JSON.stringify(fields[field.fieldPath]) === JSON.stringify(value);
}

function reply(data, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data
  };
}

global.fetch = async (url, options = {}) => {
  const target = String(url);

  if (target === "https://api.mercadopago.com/v1/orders") {
    mpOrdersCreated++;
    return reply({
      id: "ORD1",
      checkout_url: "https://www.mercadopago.com.ar/checkout/ORD1"
    });
  }

  if (target.startsWith("https://api.mercadopago.com/v1/orders/")) {
    return reply(mpOrder);
  }

  if (!target.startsWith(PREFIX)) {
    throw new Error("URL inesperada: " + target);
  }

  const rest = target.slice(PREFIX.length);
  const body = options.body ? JSON.parse(options.body) : {};

  if (rest === `${DOCS}:beginTransaction`) return reply({ transaction: "tx" });

  if (rest === `${DOCS}:rollback`) {
    rollbacks++;
    return reply({});
  }

  if (rest === `${DOCS}:batchGet`) {
    return reply(
      body.documents.map(name => {
        if (!name.startsWith("projects/")) {
          return { error: "nombre inválido " + name };
        }
        const found = store.get(name);
        return found ? { found: { name, ...found } } : { missing: name };
      })
    );
  }

  if (rest === `${DOCS}:commit`) {
    try {
      body.writes.forEach(applyWrite);
    } catch (error) {
      return reply({ error: { message: error.message } }, 400);
    }
    return reply({ writeResults: [] });
  }

  if (rest.endsWith(":runQuery")) {
    const parent = rest.slice(0, -":runQuery".length);
    const query = body.structuredQuery;
    const collectionPath = `${parent}/${query.from[0].collectionId}/`;

    const docs = [...store.entries()]
      .filter(
        ([name]) =>
          name.startsWith(collectionPath) &&
          !name.slice(collectionPath.length).includes("/")
      )
      .filter(([, doc]) => matches(doc.fields, query.where))
      .map(([name, doc]) => ({ document: { name, ...doc } }));

    return reply(docs.length ? docs : [{ readTime: "x" }]);
  }

  // Lectura de un documento: .../raffles/ID?transaction=...
  const path = rest.split("?")[0];
  const found = store.get(path);

  return found
    ? reply({ name: path, ...found })
    : reply({ error: { message: "no existe" } }, 404);
}

// ---------- Datos de prueba ----------

const NOW = Date.now();
const MIN = 60 * 1000;

function seed(options = {}) {
  const {
    raffleStatus = "open",
    price = 1000,
    resTotal = 2000,
    expiresAt = NOW + 5 * MIN,
    ticketsHeld = true,
    closedAt = null,
    createdAt = NOW - 10 * MIN
  } = options;

  store.clear();

  const raffle = {
    name: S("Sorteo de prueba"),
    quantity: N(100),
    price: N(price),
    winners: N(2),
    status: S(raffleStatus)
  };

  if (closedAt) raffle.closedAt = T(closedAt);

  put("raffles/R1", raffle);

  put("reservations/res1", {
    uid: S("U1"),
    raffleId: S("R1"),
    name: S("Ana"),
    phone: S("1122334455"),
    numbers: A(["001", "002"]),
    total: N(resTotal),
    status: S("pending"),
    expiresAt: T(expiresAt),
    createdAt: T(createdAt)
  });

  for (const number of ["001", "002"]) {
    put(`raffles/R1/tickets/${number}`, ticketsHeld
      ? {
          number: S(number), status: S("reserved"), paid: B(false),
          participantName: S("Ana"), reservationId: S("res1"),
          reservationUid: S("U1"), expiresAt: T(expiresAt)
        }
      : { number: S(number), status: S("available"), paid: B(false) });

    put(`raffles/R1/publicTickets/${number}`, ticketsHeld
      ? {
          number: S(number), status: S("reserved"),
          reservationUid: S("U1"), expiresAt: T(expiresAt)
        }
      : { number: S(number), status: S("available") });
  }
}

function makeReq(body, headers = {}, url = "/") {
  return { method: "POST", headers, body, url };
}

async function call(handler, req) {
  const res = {
    code: 200,
    body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await handler(req, res);

  return res;
}

// ---------- Mini ejecutor de pruebas ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- Pruebas de pago ----------

test("pago de Mercado Pago confirma reserva y números", async () => {
  seed();
  const result = await processReservation("t", {
    reservationId: "res1", orderId: "ORD1", paidAmount: 2000
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(read("reservations/res1").status.stringValue, "paid");
  assert.strictEqual(read("raffles/R1/tickets/001").status.stringValue, "paid");
  assert.strictEqual(read("raffles/R1/tickets/002").paid.booleanValue, true);
  assert.strictEqual(read("raffles/R1/publicTickets/001").status.stringValue, "occupied");
});

test("un pago repetido no se procesa dos veces", async () => {
  seed();
  await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  const again = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.strictEqual(again.alreadyPaid, true);
});

test("un pago que llega con la reserva vencida se acepta si los números siguen reservados", async () => {
  seed({ expiresAt: NOW - 30 * MIN });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.strictEqual(result.success, true);
});

test("si los números ya se liberaron, queda registrado el problema", async () => {
  seed({ ticketsHeld: false });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD9", paidAmount: 2000 });

  assert.strictEqual(result.issueRecorded, true);
  const reservation = read("reservations/res1");
  assert.strictEqual(reservation.status.stringValue, "pending");
  assert.ok(reservation.paymentIssue.stringValue.length > 5);
  assert.strictEqual(reservation.mpOrderId.stringValue, "ORD9");
});

test("un importe distinto al de la reserva se rechaza y se registra", async () => {
  seed();
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 1000 });
  assert.strictEqual(result.issueRecorded, true);
  assert.strictEqual(read("raffles/R1/tickets/001").status.stringValue, "reserved");
});

test("si el precio del sorteo no coincide con la reserva, se rechaza", async () => {
  seed({ price: 1500 });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.strictEqual(result.issueRecorded, true);
});

test("el precio se toma del sorteo (no está fijo en 1000)", async () => {
  seed({ price: 1500, resTotal: 3000 });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 3000 });
  assert.strictEqual(result.success, true);
});

test("con la venta cerrada se acepta una reserva anterior al cierre", async () => {
  seed({ raffleStatus: "closed", closedAt: NOW - 1 * MIN });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.strictEqual(result.success, true);
});

test("con la venta cerrada se rechaza una reserva posterior al cierre", async () => {
  seed({ raffleStatus: "closed", closedAt: NOW - 20 * MIN });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.strictEqual(result.issueRecorded, true);
});

test("con el sorteo ya realizado se rechaza el pago", async () => {
  seed({ raffleStatus: "drawn" });
  const result = await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.strictEqual(result.issueRecorded, true);
});

test("confirmación manual del administrador (transferencia)", async () => {
  seed({ expiresAt: NOW - 5 * MIN });
  const result = await processReservation("t", { reservationId: "res1", manual: true });

  assert.strictEqual(result.success, true);
  assert.strictEqual(read("reservations/res1").confirmedManually.booleanValue, true);
  assert.strictEqual(read("raffles/R1/publicTickets/002").status.stringValue, "occupied");
});

test("una confirmación manual imposible no modifica nada", async () => {
  seed({ ticketsHeld: false });
  const result = await processReservation("t", { reservationId: "res1", manual: true });

  assert.strictEqual(result.ignored, true);
  assert.ok(!result.issueRecorded);
  assert.strictEqual(read("reservations/res1").paymentIssue, undefined);
});

test("una confirmación posterior limpia el aviso de problema", async () => {
  seed({ ticketsHeld: false });
  await processReservation("t", { reservationId: "res1", orderId: "ORD1", paidAmount: 2000 });
  assert.ok(read("reservations/res1").paymentIssue);

  // El administrador vuelve a reservar los números y confirma.
  seed();
  store.get(`${DOCS}/reservations/res1`).fields.paymentIssue = S("viejo");
  const result = await processReservation("t", { reservationId: "res1", manual: true });
  assert.strictEqual(result.success, true);
  assert.strictEqual(read("reservations/res1").paymentIssue, undefined);
});

// ---------- Pruebas de la API ----------

test("close-raffle cierra la venta de cualquier sorteo", async () => {
  seed();
  const res = await call(closeRaffle, makeReq({ raffleId: "R1" }));
  assert.strictEqual(res.code, 200);
  assert.strictEqual(read("raffles/R1").status.stringValue, "closed");
  assert.ok(read("raffles/R1").closedAt);

  const second = await call(closeRaffle, makeReq({ raffleId: "R1" }));
  assert.strictEqual(second.code, 409);
});

test("close-raffle valida el ID y el sorteo", async () => {
  seed();
  assert.strictEqual((await call(closeRaffle, makeReq({ raffleId: "../x" }))).code, 400);
  assert.strictEqual((await call(closeRaffle, makeReq({}))).code, 400);
  assert.strictEqual((await call(closeRaffle, makeReq({ raffleId: "NOEXISTE" }))).code, 404);
});

test("las APIs de administrador rechazan a quien no es administrador", async () => {
  seed();
  adminResult = { valid: false, status: 403 };
  try {
    assert.strictEqual((await call(closeRaffle, makeReq({ raffleId: "R1" }))).code, 403);
    assert.strictEqual((await call(drawRaffle, makeReq({ raffleId: "R1" }))).code, 403);
    assert.strictEqual((await call(confirmPayment, makeReq({ reservationId: "res1" }))).code, 403);
  } finally {
    adminResult = { valid: true, uid: google.ADMIN_UID };
  }
});

function seedDraw({ winners = 2, paid = 5, pending = false } = {}) {
  seed({ raffleStatus: "closed", closedAt: NOW - 1 * MIN });
  store.get(`${DOCS}/raffles/R1`).fields.winners = N(winners);
  store.delete(`${DOCS}/reservations/res1`);

  for (let i = 1; i <= paid; i++) {
    const number = String(10 + i).padStart(3, "0");
    put(`raffles/R1/tickets/${number}`, {
      number: S(number), status: S("paid"), paid: B(true),
      participantName: S("Persona " + i)
    });
  }

  // Número no pagado: nunca debe salir sorteado.
  put("raffles/R1/tickets/099", {
    number: S("099"), status: S("available"), paid: B(false)
  });

  if (pending) {
    put("reservations/vigente", {
      raffleId: S("R1"), status: S("pending"), expiresAt: T(NOW + 5 * MIN)
    });
  }
}

test("draw-raffle elige ganadores distintos entre los números pagados", async () => {
  seedDraw({ winners: 2, paid: 5 });
  const res = await call(drawRaffle, makeReq({ raffleId: "R1" }));

  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.winners.length, 2);
  assert.notStrictEqual(res.body.winners[0].number, res.body.winners[1].number);
  assert.ok(res.body.winners.every(w => w.number !== "099"));

  const raffle = read("raffles/R1");
  assert.strictEqual(raffle.status.stringValue, "drawn");
  assert.strictEqual(raffle.drawResults.arrayValue.values.length, 2);
});

test("draw-raffle respeta la cantidad de ganadores del sorteo (1 y 3)", async () => {
  seedDraw({ winners: 1, paid: 3 });
  assert.strictEqual((await call(drawRaffle, makeReq({ raffleId: "R1" }))).body.winners.length, 1);

  seedDraw({ winners: 3, paid: 4 });
  assert.strictEqual((await call(drawRaffle, makeReq({ raffleId: "R1" }))).body.winners.length, 3);
});

test("draw-raffle no sortea con pocos números pagados", async () => {
  seedDraw({ winners: 2, paid: 1 });
  const res = await call(drawRaffle, makeReq({ raffleId: "R1" }));
  assert.strictEqual(res.code, 409);
  assert.strictEqual(read("raffles/R1").status.stringValue, "closed");
});

test("draw-raffle espera si hay reservas vigentes", async () => {
  seedDraw({ winners: 2, paid: 5, pending: true });
  const res = await call(drawRaffle, makeReq({ raffleId: "R1" }));
  assert.strictEqual(res.code, 409);
  assert.match(res.body.error, /reservas todavía vigentes/);
});

test("draw-raffle exige la venta cerrada y no repite el sorteo", async () => {
  seedDraw({ winners: 2, paid: 5 });
  store.get(`${DOCS}/raffles/R1`).fields.status = S("open");
  assert.strictEqual((await call(drawRaffle, makeReq({ raffleId: "R1" }))).code, 409);

  seedDraw({ winners: 2, paid: 5 });
  await call(drawRaffle, makeReq({ raffleId: "R1" }));
  assert.strictEqual((await call(drawRaffle, makeReq({ raffleId: "R1" }))).code, 409);
});

test("create-order cobra el precio del sorteo y alarga la reserva una sola vez", async () => {
  seed({ price: 1500, resTotal: 3000 });
  currentUid = "U1";
  mpOrdersCreated = 0;

  const before = Date.parse(read("reservations/res1").expiresAt.timestampValue);
  const res = await call(createOrder, makeReq({ reservationId: "res1" }, { authorization: "Bearer abc" }));

  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.total, 3000);
  assert.ok(res.body.checkoutUrl.includes("ORD1"));

  const reservation = read("reservations/res1");
  const after = Date.parse(reservation.expiresAt.timestampValue);
  assert.ok(after > before + 10 * MIN);
  assert.ok(reservation.checkoutStartedAt);
  assert.strictEqual(
    read("raffles/R1/tickets/001").expiresAt.timestampValue,
    reservation.expiresAt.timestampValue
  );
  assert.strictEqual(
    read("raffles/R1/publicTickets/002").expiresAt.timestampValue,
    reservation.expiresAt.timestampValue
  );

  await call(createOrder, makeReq({ reservationId: "res1" }, { authorization: "Bearer abc" }));
  assert.strictEqual(
    read("reservations/res1").expiresAt.timestampValue,
    reservation.expiresAt.timestampValue
  );
});

test("create-order valida dueño, vencimiento y precio", async () => {
  const headers = { authorization: "Bearer abc" };

  seed();
  currentUid = "OTRO";
  assert.strictEqual((await call(createOrder, makeReq({ reservationId: "res1" }, headers))).code, 403);

  seed({ expiresAt: NOW - MIN });
  currentUid = "U1";
  assert.strictEqual((await call(createOrder, makeReq({ reservationId: "res1" }, headers))).code, 400);

  seed({ price: 1500 });
  assert.strictEqual((await call(createOrder, makeReq({ reservationId: "res1" }, headers))).code, 409);

  assert.strictEqual((await call(createOrder, makeReq({ reservationId: "res1" }, {}))).code, 401);
  assert.strictEqual((await call(createOrder, makeReq({ reservationId: "../x" }, headers))).code, 400);
});

test("report-payment guarda el aviso y reserva los números 3 horas", async () => {
  seed({ expiresAt: NOW - 2 * MIN });
  currentUid = "U1";

  const res = await call(
    reportPayment,
    makeReq({ reservationId: "res1", method: "naranjax" }, { authorization: "Bearer abc" })
  );

  assert.strictEqual(res.code, 200, JSON.stringify(res.body));

  const reservation = read("reservations/res1");
  assert.strictEqual(reservation.paymentMethod.stringValue, "naranjax");
  assert.strictEqual(reservation.paymentReported.booleanValue, true);

  const hold = Date.parse(reservation.expiresAt.timestampValue) - Date.now();
  assert.ok(hold > 170 * MIN && hold <= 181 * MIN);

  // Un segundo aviso no alarga otra vez la reserva.
  const second = await call(
    reportPayment,
    makeReq({ reservationId: "res1", method: "cuentadni" }, { authorization: "Bearer abc" })
  );
  assert.strictEqual(second.code, 200);
  assert.strictEqual(read("reservations/res1").expiresAt.timestampValue, reservation.expiresAt.timestampValue);
  assert.strictEqual(read("reservations/res1").paymentMethod.stringValue, "cuentadni");
});

test("report-payment valida medio, dueño y números", async () => {
  const headers = { authorization: "Bearer abc" };

  seed();
  currentUid = "U1";
  assert.strictEqual((await call(reportPayment, makeReq({ reservationId: "res1", method: "bitcoin" }, headers))).code, 400);

  currentUid = "OTRO";
  assert.strictEqual((await call(reportPayment, makeReq({ reservationId: "res1", method: "naranjax" }, headers))).code, 403);

  currentUid = "U1";
  seed({ ticketsHeld: false });
  assert.strictEqual((await call(reportPayment, makeReq({ reservationId: "res1", method: "naranjax" }, headers))).code, 409);
});

test("confirm-payment (administrador) confirma una transferencia", async () => {
  seed();
  const res = await call(confirmPayment, makeReq({ reservationId: "res1" }));
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(read("reservations/res1").status.stringValue, "paid");

  const again = await call(confirmPayment, makeReq({ reservationId: "res1" }));
  assert.strictEqual(again.code, 200);
  assert.strictEqual(again.body.alreadyPaid, true);

  assert.strictEqual((await call(confirmPayment, makeReq({ reservationId: "noexiste" }))).code, 409);
});

// ---------- Webhook de Mercado Pago ----------

function signedWebhookRequest(orderId, secret = process.env.MP_WEBHOOK_SECRET, lowercase = false) {
  const ts = String(Date.now());
  const requestId = "req-123";
  const id = lowercase ? orderId.toLowerCase() : orderId;
  const hash = crypto.createHmac("sha256", secret)
    .update(`id:${id};request-id:${requestId};ts:${ts};`)
    .digest("hex");

  return makeReq(
    {},
    { "x-signature": `ts=${ts},v1=${hash}`, "x-request-id": requestId },
    `/api/mercadopago-webhook?data.id=${orderId}&type=order`
  );
}

function paidOrder(total = "2000.00") {
  return {
    id: "ORD1",
    status: "processed",
    status_detail: "accredited",
    currency: "ARS",
    external_reference: "res1",
    total_amount: total,
    total_paid_amount: total,
    transactions: { payments: [{ status: "processed", status_detail: "accredited" }] }
  };
}

test("webhook: firma válida y pago acreditado confirma la reserva", async () => {
  seed();
  mpOrder = paidOrder();
  const res = await call(webhook, signedWebhookRequest("ORD1"));
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(read("reservations/res1").status.stringValue, "paid");
});

test("webhook: acepta la firma calculada con el id en minúsculas", async () => {
  seed();
  mpOrder = paidOrder();
  const res = await call(webhook, signedWebhookRequest("ORD1", undefined, true));
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.success, true);
});

test("webhook: rechaza firmas falsas y notificaciones inválidas", async () => {
  seed();
  mpOrder = paidOrder();
  assert.strictEqual((await call(webhook, signedWebhookRequest("ORD1", "otro-secreto"))).code, 401);
  assert.strictEqual((await call(webhook, makeReq({}, {}, "/api/x?data.id=ORD1&type=order"))).code, 401);
  assert.strictEqual((await call(webhook, makeReq({}, {}, "/api/x?type=payment"))).code, 400);
  assert.strictEqual(read("reservations/res1").status.stringValue, "pending");
});

test("webhook: ignora órdenes no acreditadas y con importes distintos", async () => {
  seed();
  mpOrder = { ...paidOrder(), status: "pending" };
  assert.strictEqual((await call(webhook, signedWebhookRequest("ORD1"))).body.processed, false);

  mpOrder = { ...paidOrder(), total_paid_amount: "1000.00" };
  assert.strictEqual((await call(webhook, signedWebhookRequest("ORD1"))).body.processed, false);

  assert.strictEqual(read("reservations/res1").status.stringValue, "pending");
});

// ---------- Ejecución ----------

(async () => {
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("  ✓", name);
    } catch (error) {
      failed++;
      console.log("  ✗", name);
      console.log("    ", error.message);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} pruebas correctas`);
  process.exit(failed ? 1 : 0);
})();
