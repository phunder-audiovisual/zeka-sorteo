
const crypto = require("crypto");

const PROJECT_ID = "zeka-sorteo";
const RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";
const TICKET_PRICE = 1000;

async function getFirestoreDocument(path, token) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const error = new Error("No se pudo verificar la reserva.");
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function stableIdempotencyKey(reservationId) {
  const hash = crypto
    .createHash("sha256")
    .update(reservationId)
    .digest("hex")
    .slice(0, 32)
    .split("");

  hash[12] = "4";
  hash[16] = (
    (parseInt(hash[16], 16) & 3) | 8
  ).toString(16);

  const value = hash.join("");

  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32)
  ].join("-");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido."
    });
  }

  try {
    const token = req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    );

    if (!token) {
      return res.status(401).json({
        error: "Tenés que iniciar sesión."
      });
    }

    const reservationId = req.body?.reservationId;

    if (
      typeof reservationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(reservationId)
    ) {
      return res.status(400).json({
        error: "Identificador de reserva inválido."
      });
    }

    const accessToken = process.env.MP_ACCESS_TOKEN;

    if (!accessToken) {
      return res.status(500).json({
        error: "Falta configurar Mercado Pago."
      });
    }

    // Consultar primero la reserva.
const reservation = await getFirestoreDocument(
  `reservations/${encodeURIComponent(reservationId)}`,
  token
);

const fields = reservation.fields || {};

const uid = fields.uid?.stringValue;
const raffleId = fields.raffleId?.stringValue;
const status = fields.status?.stringValue;
const expiresAt = fields.expiresAt?.timestampValue;
const createdAt = fields.createdAt?.timestampValue;

const numbers =
  fields.numbers?.arrayValue?.values?.map(
    item => item.stringValue
  ) || [];

if (raffleId !== RAFFLE_ID) {
  return res.status(400).json({
    error: "La reserva no corresponde a este sorteo."
  });
}

// Verificar el estado de la venta.
const raffle = await getFirestoreDocument(
  `raffles/${encodeURIComponent(RAFFLE_ID)}`,
  token
);

const raffleStatus = raffle.fields?.status?.stringValue;
const closedAt = raffle.fields?.closedAt?.timestampValue;

if (raffleStatus === "closed") {
  if (
    !createdAt ||
    !closedAt ||
    Date.parse(createdAt) >= Date.parse(closedAt)
  ) {
    return res.status(409).json({
      error: "La reserva no fue realizada antes del cierre."
    });
  }
} else if (raffleStatus !== "open") {
  return res.status(409).json({
    error: "El sorteo ya fue realizado."
  });
}

    if (status !== "pending") {
      return res.status(400).json({
        error: "La reserva no está pendiente."
      });
    }

    if (
      !expiresAt ||
      Date.parse(expiresAt) <= Date.now()
    ) {
      return res.status(400).json({
        error: "La reserva venció. Volvé a seleccionar tus números."
      });
    }

    if (
      !uid ||
      numbers.length < 1 ||
      numbers.length > 10 ||
      numbers.some(
        n => typeof n !== "string" || !/^\d{3}$/.test(n)
      ) ||
      new Set(numbers).size !== numbers.length
    ) {
      return res.status(400).json({
        error: "Los números de la reserva no son válidos."
      });
    }

    // Verificar que los números pertenezcan a la reserva.
    const tickets = await Promise.all(
      numbers.map(number =>
        getFirestoreDocument(
          `raffles/${RAFFLE_ID}/tickets/${number}`,
          token
        )
      )
    );

    for (const ticket of tickets) {
      const data = ticket.fields || {};

      if (
        data.status?.stringValue !== "reserved" ||
        data.reservationId?.stringValue !== reservationId ||
        data.reservationUid?.stringValue !== uid ||
        !data.expiresAt?.timestampValue ||
        Date.parse(data.expiresAt.timestampValue) <= Date.now()
      ) {
        return res.status(400).json({
          error: "Uno de los números ya no pertenece a esta reserva."
        });
      }
    }

    // Calcular el precio en el servidor.
    const total = numbers.length * TICKET_PRICE;

    const order = {
      type: "online",
      processing_mode: "manual",
      capture_mode: "automatic_async",
      total_amount: total.toFixed(2),
      external_reference: reservationId,
      description: "ZEKA-SORTEO - Participación",
      items: [
        {
          title: "Número de ZEKA-SORTEO",
          quantity: numbers.length,
          unit_price: TICKET_PRICE.toFixed(2)
        }
      ]
    };

    const mpResponse = await fetch(
      "https://api.mercadopago.com/v1/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key":
            stableIdempotencyKey(reservationId)
        },
        body: JSON.stringify(order)
      }
    );

    const mpData = await mpResponse.json();

    if (!mpResponse.ok || !mpData.checkout_url) {
      console.error("Error Mercado Pago:", mpData);

      return res.status(502).json({
        error: "Mercado Pago no pudo crear la orden de pago."
      });
    }

    return res.status(200).json({
      success: true,
      orderId: mpData.id,
      checkoutUrl: mpData.checkout_url,
      total
    });

  } catch (error) {
    console.error("Error create-order:", error);

    return res.status(
      error.status === 403 ? 403 : 500
    ).json({
      error: error.status === 403
        ? "No tenés permiso para consultar esta reserva."
        : "No se pudo preparar el pago."
    });
  }
};
  
