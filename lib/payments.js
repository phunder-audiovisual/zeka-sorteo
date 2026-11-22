"use strict";

// Lógica compartida de reservas y pagos (webhook de Mercado Pago,
// confirmación manual del administrador, aviso de transferencia y
// creación de órdenes de pago).

const {
  DOCS,
  ROOT,
  ID_PATTERN,
  HttpError,
  getString,
  getNumber,
  getTimestamp,
  firestoreRequest
} = require("./google");

// ---------- Helpers ----------

function ticketNames(raffleId, numbers) {
  return {
    privateNames: numbers.map(
      number => `${DOCS}/raffles/${raffleId}/tickets/${number}`
    ),
    publicNames: numbers.map(
      number => `${DOCS}/raffles/${raffleId}/publicTickets/${number}`
    )
  };
}

async function batchGet(token, names, transaction) {
  const body = { documents: names };

  if (transaction) body.transaction = transaction;

  const results = await firestoreRequest(`${ROOT}:batchGet`, token, {
    method: "POST",
    body: JSON.stringify(body)
  });

  const found = new Map();

  for (const item of Array.isArray(results) ? results : [results]) {
    if (item.found) found.set(item.found.name, item.found);
  }

  return found;
}

function parseReservation(fields) {
  return {
    uid: getString(fields, "uid"),
    raffleId: getString(fields, "raffleId"),
    status: getString(fields, "status"),
    total: getNumber(fields, "total"),
    createdAt: getTimestamp(fields, "createdAt"),
    expiresAt: getTimestamp(fields, "expiresAt"),
    paymentReported: fields?.paymentReported?.booleanValue === true,
    checkoutStarted: Boolean(getTimestamp(fields, "checkoutStartedAt")),
    numbers: (fields?.numbers?.arrayValue?.values || []).map(
      item => item.stringValue
    )
  };
}

function validNumbers(numbers) {
  return (
    numbers.length >= 1 &&
    numbers.length <= 10 &&
    numbers.every(n => typeof n === "string" && /^\d{3}$/.test(n)) &&
    new Set(numbers).size === numbers.length
  );
}

function validPrice(price) {
  return Number.isSafeInteger(price) && price >= 1;
}

// Una reserva solo puede pagarse mientras la venta está abierta, o si fue
// creada antes del cierre.
function raffleBlockReason(raffleFields, reservationCreatedAt) {
  const status = getString(raffleFields, "status");

  if (status === "open") return null;

  if (status === "closed") {
    const closedAt = getTimestamp(raffleFields, "closedAt");

    if (
      !reservationCreatedAt ||
      !closedAt ||
      Date.parse(reservationCreatedAt) >= Date.parse(closedAt)
    ) {
      return "La reserva fue creada después del cierre de la venta.";
    }

    return null;
  }

  return "El sorteo ya fue realizado o no está disponible.";
}

function ticketsStillHeld(privateFields, publicFields, reservationId, uid) {
  return (
    getString(privateFields, "status") === "reserved" &&
    getString(privateFields, "reservationId") === reservationId &&
    getString(privateFields, "reservationUid") === uid &&
    privateFields?.paid?.booleanValue !== true &&
    getString(publicFields, "status") === "reserved" &&
    getString(publicFields, "reservationUid") === uid
  );
}

// ---------- Lectura validada de una reserva (sin transacción) ----------

async function loadHeldReservation(token, reservationId, options = {}) {
  const { expectedUid = null, allowExpired = false } = options;

  if (typeof reservationId !== "string" || !ID_PATTERN.test(reservationId)) {
    throw new HttpError(400, "Identificador de reserva inválido.");
  }

  const reservationName = `${DOCS}/reservations/${reservationId}`;

  const first = await batchGet(token, [reservationName]);
  const reservationDoc = first.get(reservationName);

  if (!reservationDoc) {
    throw new HttpError(404, "No se encontró la reserva.");
  }

  const reservation = parseReservation(reservationDoc.fields);

  if (expectedUid && reservation.uid !== expectedUid) {
    throw new HttpError(403, "Esta reserva no te pertenece.");
  }

  if (reservation.status !== "pending") {
    throw new HttpError(409, "La reserva no está pendiente.");
  }

  if (
    !reservation.uid ||
    !ID_PATTERN.test(reservation.raffleId) ||
    !validNumbers(reservation.numbers)
  ) {
    throw new HttpError(400, "Los datos de la reserva no son válidos.");
  }

  if (
    !allowExpired &&
    (!reservation.expiresAt || Date.parse(reservation.expiresAt) <= Date.now())
  ) {
    throw new HttpError(
      400,
      "La reserva venció. Volvé a seleccionar tus números."
    );
  }

  const raffleName = `${DOCS}/raffles/${reservation.raffleId}`;
  const { privateNames, publicNames } = ticketNames(
    reservation.raffleId,
    reservation.numbers
  );

  const docs = await batchGet(token, [
    raffleName,
    ...privateNames,
    ...publicNames
  ]);

  const raffleDoc = docs.get(raffleName);

  if (!raffleDoc) {
    throw new HttpError(404, "No se encontró el sorteo de esta reserva.");
  }

  const blocked = raffleBlockReason(raffleDoc.fields, reservation.createdAt);

  if (blocked) throw new HttpError(409, blocked);

  const price = getNumber(raffleDoc.fields, "price");

  if (!validPrice(price)) {
    throw new HttpError(409, "El sorteo no tiene un precio válido.");
  }

  if (reservation.total !== reservation.numbers.length * price) {
    throw new HttpError(
      409,
      "El precio del sorteo cambió después de la reserva. Volvé a seleccionar tus números."
    );
  }

  for (let i = 0; i < reservation.numbers.length; i++) {
    const privateDoc = docs.get(privateNames[i]);
    const publicDoc = docs.get(publicNames[i]);

    if (
      !privateDoc ||
      !publicDoc ||
      !ticketsStillHeld(
        privateDoc.fields,
        publicDoc.fields,
        reservationId,
        reservation.uid
      )
    ) {
      throw new HttpError(
        409,
        "Uno de los números ya no pertenece a esta reserva. Volvé a seleccionarlos."
      );
    }
  }

  return {
    reservationName,
    reservation,
    raffleId: reservation.raffleId,
    raffleFields: raffleDoc.fields,
    price,
    privateNames,
    publicNames
  };
}

// Alarga el tiempo de reserva de la reserva y de todos sus números.
async function extendHold(token, held, expiresAtIso, extraFields = {}) {
  const expiry = { timestampValue: expiresAtIso };
  const reservationFields = { expiresAt: expiry, ...extraFields };

  const writes = [
    {
      update: { name: held.reservationName, fields: reservationFields },
      updateMask: { fieldPaths: Object.keys(reservationFields) },
      currentDocument: { exists: true }
    }
  ];

  for (const name of [...held.privateNames, ...held.publicNames]) {
    writes.push({
      update: { name, fields: { expiresAt: expiry } },
      updateMask: { fieldPaths: ["expiresAt"] },
      currentDocument: { exists: true }
    });
  }

  await firestoreRequest(`${ROOT}:commit`, token, {
    method: "POST",
    body: JSON.stringify({ writes })
  });
}

// ---------- Confirmar un pago (transacción atómica) ----------
//
// Se usa desde el webhook de Mercado Pago (manual = false, con el importe
// pagado) y desde el botón del administrador para transferencias
// (manual = true).
//
// Un pago se acepta aunque la reserva haya vencido, siempre que los números
// todavía no se hayan liberado ni asignado a otra persona. Si algo no
// coincide en un pago de Mercado Pago, el motivo queda guardado en la reserva
// (campo "paymentIssue") para que el administrador lo vea y devuelva el dinero.

async function processReservation(token, options) {
  const {
    reservationId,
    orderId = null,
    paidAmount = null,
    manual = false
  } = options;

  if (typeof reservationId !== "string" || !ID_PATTERN.test(reservationId)) {
    return { ignored: true, reason: "Identificador de reserva inválido." };
  }

  const started = await firestoreRequest(
    `${ROOT}:beginTransaction`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ options: { readWrite: {} } })
    }
  );

  const transaction = started.transaction;

  if (!transaction) {
    throw new Error("No se pudo iniciar la transacción.");
  }

  let finished = false;

  async function rollback() {
    if (finished) return;
    finished = true;

    try {
      await firestoreRequest(`${ROOT}:rollback`, token, {
        method: "POST",
        body: JSON.stringify({ transaction })
      });
    } catch (error) {
      console.error("No se pudo cerrar la transacción:", error);
    }
  }

  const reservationName = `${DOCS}/reservations/${reservationId}`;

  try {
    const first = await batchGet(token, [reservationName], transaction);
    const reservationDoc = first.get(reservationName);

    if (!reservationDoc) {
      await rollback();
      return { ignored: true, reason: "Reserva inexistente." };
    }

    const reservation = parseReservation(reservationDoc.fields);

    if (reservation.status === "paid") {
      await rollback();
      return { alreadyPaid: true };
    }

    // Rechaza el pago. En Mercado Pago el dinero ya se cobró, así que el
    // motivo se guarda en la reserva para poder devolverlo.
    async function reject(reason) {
      if (manual) {
        await rollback();
        return { ignored: true, reason };
      }

      const fields = {
        paymentIssue: { stringValue: reason },
        paymentIssueAt: { timestampValue: new Date().toISOString() }
      };

      if (orderId) fields.mpOrderId = { stringValue: orderId };

      await firestoreRequest(`${ROOT}:commit`, token, {
        method: "POST",
        body: JSON.stringify({
          transaction,
          writes: [
            {
              update: { name: reservationName, fields },
              updateMask: { fieldPaths: Object.keys(fields) },
              currentDocument: { exists: true }
            }
          ]
        })
      });

      finished = true;

      return { ignored: true, reason, issueRecorded: true };
    }

    if (reservation.status !== "pending") {
      return await reject("La reserva ya no estaba pendiente al recibir el pago.");
    }

    if (
      !reservation.uid ||
      !ID_PATTERN.test(reservation.raffleId) ||
      !validNumbers(reservation.numbers)
    ) {
      return await reject("Los datos de la reserva no son válidos.");
    }

    const raffleName = `${DOCS}/raffles/${reservation.raffleId}`;
    const { privateNames, publicNames } = ticketNames(
      reservation.raffleId,
      reservation.numbers
    );

    const docs = await batchGet(
      token,
      [raffleName, ...privateNames, ...publicNames],
      transaction
    );

    const raffleDoc = docs.get(raffleName);

    if (!raffleDoc) {
      return await reject("El sorteo de la reserva no existe.");
    }

    const blocked = raffleBlockReason(raffleDoc.fields, reservation.createdAt);

    if (blocked) return await reject(blocked);

    const price = getNumber(raffleDoc.fields, "price");

    if (!validPrice(price)) {
      return await reject("El sorteo no tiene un precio válido.");
    }

    const expectedTotal = reservation.numbers.length * price;

    if (reservation.total !== expectedTotal) {
      return await reject(
        "El total de la reserva no coincide con el precio del sorteo."
      );
    }

    if (
      !manual &&
      (!Number.isFinite(paidAmount) ||
        Math.round(paidAmount * 100) !== Math.round(expectedTotal * 100))
    ) {
      return await reject("El importe pagado no coincide con la reserva.");
    }

    for (let i = 0; i < reservation.numbers.length; i++) {
      const privateDoc = docs.get(privateNames[i]);
      const publicDoc = docs.get(publicNames[i]);

      if (
        !privateDoc ||
        !publicDoc ||
        !ticketsStillHeld(
          privateDoc.fields,
          publicDoc.fields,
          reservationId,
          reservation.uid
        )
      ) {
        return await reject(
          "Los números ya no pertenecen a esta reserva (se liberaron al vencer el tiempo)."
        );
      }
    }

    const now = new Date().toISOString();

    const reservationFields = {
      status: { stringValue: "paid" },
      paidAt: { timestampValue: now }
    };

    if (orderId) reservationFields.mpOrderId = { stringValue: orderId };
    if (manual) reservationFields.confirmedManually = { booleanValue: true };

    const writes = [
      {
        update: { name: reservationName, fields: reservationFields },
        // Los campos de la máscara que no están en "fields" se eliminan:
        // así se limpia cualquier aviso de problema anterior.
        updateMask: {
          fieldPaths: [
            ...Object.keys(reservationFields),
            "paymentIssue",
            "paymentIssueAt"
          ]
        }
      }
    ];

    for (const name of privateNames) {
      writes.push({
        update: {
          name,
          fields: {
            status: { stringValue: "paid" },
            paid: { booleanValue: true }
          }
        },
        updateMask: { fieldPaths: ["status", "paid"] }
      });
    }

    for (const name of publicNames) {
      writes.push({
        update: {
          name,
          fields: {
            status: { stringValue: "occupied" },
            expiresAt: { nullValue: null }
          }
        },
        updateMask: { fieldPaths: ["status", "expiresAt"] }
      });
    }

    await firestoreRequest(`${ROOT}:commit`, token, {
      method: "POST",
      body: JSON.stringify({ transaction, writes })
    });

    finished = true;

    return {
      success: true,
      orderId,
      total: expectedTotal,
      numbers: reservation.numbers
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}

module.exports = {
  loadHeldReservation,
  extendHold,
  processReservation
};
