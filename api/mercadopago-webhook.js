
const crypto = require("crypto");

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const RAFFLE_ID = "fHG7phVJcVHScDpuzx1B";
const TICKET_PRICE = 1000;

function getField(fields, name) {
  return fields?.[name];
}

function getString(fields, name) {
  return getField(fields, name)?.stringValue;
}

function getNumber(fields, name) {
  const field = getField(fields, name);

  if (!field) return null;

  return Number(
    field.integerValue ?? field.doubleValue
  );
}


function verifySignature(req, orderId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];

  if (!secret || !signature || !requestId) {
    console.error("MP firma: faltan datos", {
      secretConfigured: Boolean(secret),
      signatureReceived: Boolean(signature),
      requestIdReceived: Boolean(requestId),
      orderIdReceived: Boolean(orderId)
    });
    return false;
  }

  const parts = {};

  signature.split(",").forEach(part => {
    const [key, value] = part.trim().split("=");
    if (key && value) parts[key] = value;
  });

  const ts = parts.ts;
  const receivedHash = parts.v1;

  if (!ts || !/^[a-f0-9]{64}$/i.test(receivedHash || "")) {
    console.error("MP firma: formato inválido");
    return false;
  }

  const manifest =
    `id:${orderId};request-id:${requestId};ts:${ts};`;

  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  const received = Buffer.from(receivedHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");

  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);

  if (!valid) {
    console.error("MP firma: hash no coincide", {
      orderId,
      requestIdReceived: true,
      timestampReceived: true
    });
  }

  return valid;
}

async function getGoogleAccessToken() {
  const {
    GCP_PROJECT_NUMBER,
    GCP_SERVICE_ACCOUNT_EMAIL,
    GCP_WORKLOAD_IDENTITY_POOL_ID,
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
  } = process.env;

  if (
    !PROJECT_ID ||
    !GCP_PROJECT_NUMBER ||
    !GCP_SERVICE_ACCOUNT_EMAIL ||
    !GCP_WORKLOAD_IDENTITY_POOL_ID ||
    !GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
  ) {
    throw new Error("Faltan variables de Google Cloud.");
  }

  const { getVercelOidcToken } =
    await import("@vercel/oidc");

  const {
    ExternalAccountClient
  } = require("google-auth-library");

  const audience =
    `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}` +
    `/locations/global/workloadIdentityPools/` +
    `${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/` +
    `${GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`;

  const credentials = {
    type: "external_account",
    audience,
    subject_token_type:
      "urn:ietf:params:oauth:token-type:jwt",
    token_url:
      "https://sts.googleapis.com/v1/token",

    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/` +
      `${GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,

    subject_token_supplier: {
      getSubjectToken: async () =>
        await getVercelOidcToken()
    }
  };

  const client =
    ExternalAccountClient.fromJSON(credentials);

  if (!client) {
    throw new Error("No se pudo crear el cliente de Google.");
  }

  const result = await client.getAccessToken();

  if (!result.token) {
    throw new Error("Google no devolvió un token.");
  }

  return result.token;
}

async function googleRequest(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Error Firestore:", text);
    throw new Error("Error consultando Firestore.");
  }

  return text ? JSON.parse(text) : {};
}

function parseBatchGet(text) {
  const value = text.trim();

  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return value
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
}

async function beginTransaction(base, token) {
  return googleRequest(
    `${base}:beginTransaction`,
    token,
    {
      options: {
        readWrite: {}
      }
    }
  );
}

async function rollbackTransaction(base, token, transaction) {
  try {
    await googleRequest(
      `${base}:rollback`,
      token,
      { transaction }
    );
  } catch (error) {
    console.error("No se pudo cerrar la transacción:", error);
  }
}

async function processReservation(
  accessToken,
  reservationId,
  orderId,
  paidAmount
) {
  const base =
    `https://firestore.googleapis.com/v1/projects/` +
    `${PROJECT_ID}/databases/(default)/documents`;

  const transactionData =
    await beginTransaction(base, accessToken);

  const transaction = transactionData.transaction;

  if (!transaction) {
    throw new Error("No se pudo iniciar la transacción.");
  }

  const reservationName =
    `projects/${PROJECT_ID}/databases/(default)/documents/` +
    `reservations/${reservationId}`;

  try {
    // Leer primero la reserva.
    const firstResponse = await fetch(
      `${base}:batchGet`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          documents: [reservationName],
          transaction
        })
      }
    );

    const firstText = await firstResponse.text();

    if (!firstResponse.ok) {
      throw new Error("No se pudo consultar la reserva.");
    }

    const firstResults = parseBatchGet(firstText);
    const reservationDoc = firstResults.find(r => r.found)?.found;

    if (!reservationDoc) {
      await rollbackTransaction(base, accessToken, transaction);
      return { ignored: true, reason: "Reserva inexistente." };
    }

    const reservationFields = reservationDoc.fields || {};

    if (getString(reservationFields, "status") === "paid") {
      await rollbackTransaction(base, accessToken, transaction);
      return { alreadyPaid: true };
    }

    const raffleId =
      getString(reservationFields, "raffleId");

    const uid =
      getString(reservationFields, "uid");

    const status =
      getString(reservationFields, "status");

    const numbers =
      reservationFields.numbers?.arrayValue?.values
        ?.map(item => item.stringValue) || [];

    const expiresAt =
      reservationFields.expiresAt?.timestampValue;

    const total =
      getNumber(reservationFields, "total");

    if (
      raffleId !== RAFFLE_ID ||
      status !== "pending" ||
      !uid ||
      !expiresAt ||
      Date.parse(expiresAt) <= Date.now() ||
      numbers.length < 1 ||
      numbers.length > 10 ||
      new Set(numbers).size !== numbers.length ||
      numbers.some(n => !/^\d{3}$/.test(n)) ||
      total !== numbers.length * TICKET_PRICE
    ) {
      await rollbackTransaction(base, accessToken, transaction);
      return { ignored: true, reason: "Reserva no válida." };
    }

    const expectedTotal = numbers.length * TICKET_PRICE;
    if (
  Math.round(paidAmount * 100) !==
  Math.round(expectedTotal * 100)
) {
  await rollbackTransaction(base, accessToken, transaction);
  return {
    ignored: true,
    reason: "El importe pagado no coincide con la reserva."
  };
}

    const privateNames = numbers.map(number =>
      `${base}/raffles/${RAFFLE_ID}/tickets/${number}`
    );

    const publicNames = numbers.map(number =>
      `${base}/raffles/${RAFFLE_ID}/publicTickets/${number}`
    );

    const allNames = [
      ...privateNames,
      ...publicNames
    ];

    // Leer todos los números dentro de la misma transacción.
    const ticketResponse = await fetch(
      `${base}:batchGet`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          documents: allNames,
          transaction
        })
      }
    );

    const ticketText = await ticketResponse.text();

    if (!ticketResponse.ok) {
      throw new Error("No se pudieron consultar los números.");
    }

    const ticketResults = parseBatchGet(ticketText);

    const documents = new Map();

    for (const result of ticketResults) {
      if (result.found) {
        documents.set(result.found.name, result.found);
      }
    }

    const privateDocs = privateNames.map(name =>
      documents.get(name)
    );

    const publicDocs = publicNames.map(name =>
      documents.get(name)
    );

    if (
      privateDocs.some(doc => !doc) ||
      publicDocs.some(doc => !doc)
    ) {
      await rollbackTransaction(base, accessToken, transaction);
      return { ignored: true, reason: "Faltan documentos de números." };
    }

    // Verificar que todos los números sigan perteneciendo
    // a la misma reserva.
    for (let i = 0; i < numbers.length; i++) {
      const privateFields = privateDocs[i].fields || {};
      const publicFields = publicDocs[i].fields || {};

      if (
        getString(privateFields, "status") !== "reserved" ||
        getString(privateFields, "reservationId") !== reservationId ||
        getString(privateFields, "reservationUid") !== uid ||
        privateFields.paid?.booleanValue === true ||
        getString(publicFields, "status") !== "reserved" ||
        getString(publicFields, "reservationUid") !== uid
      ) {
        await rollbackTransaction(base, accessToken, transaction);
        return {
          ignored: true,
          reason: "Un número ya no pertenece a esta reserva."
        };
      }
    }

    const now = new Date().toISOString();

    const writes = [];

    // Marcar la reserva como pagada.
    writes.push({
      update: {
        name: reservationName,
        fields: {
          status: { stringValue: "paid" },
          paidAt: { timestampValue: now }
        }
      },
      updateMask: {
        fieldPaths: ["status", "paidAt"]
      }
    });

    // Marcar los números privados como pagados.
    for (const name of privateNames) {
      writes.push({
        update: {
          name,
          fields: {
            status: { stringValue: "paid" },
            paid: { booleanValue: true }
          }
        },
        updateMask: {
          fieldPaths: ["status", "paid"]
        }
      });
    }

    // Marcar los números públicos como ocupados.
    for (const name of publicNames) {
      writes.push({
        update: {
          name,
          fields: {
            status: { stringValue: "occupied" },
            expiresAt: { nullValue: null }
          }
        },
        updateMask: {
          fieldPaths: ["status", "expiresAt"]
        }
      });
    }

    // Guardar todos los cambios de forma atómica.
    const commitResponse = await fetch(
      `${base}:commit`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          transaction,
          writes
        })
      }
    );

    const commitText = await commitResponse.text();

    if (!commitResponse.ok) {
      console.error("Error al confirmar Firestore:", commitText);
      throw new Error("No se pudieron guardar los cambios.");
    }

    return {
      success: true,
      orderId,
      total: expectedTotal,
      numbers
    };

  } catch (error) {
    await rollbackTransaction(base, accessToken, transaction);
    throw error;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido."
    });
  }

  try {
    const url = new URL(
      req.url,
      "https://zeka-sorteo.vercel.app"
    );

    const orderId = url.searchParams.get("data.id");
    const type = url.searchParams.get("type");

    if (
      type !== "order" ||
      !orderId ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(orderId)
    ) {
      return res.status(400).json({
        error: "Notificación inválida."
      });
    }

    if (!verifySignature(req, orderId)) {
      return res.status(401).json({
        error: "Firma no válida."
      });
    }

    const mpToken = process.env.MP_ACCESS_TOKEN;

    if (!mpToken) {
      throw new Error("Falta MP_ACCESS_TOKEN.");
    }

    // Consultar la orden directamente a Mercado Pago.
    const mpResponse = await fetch(
      `https://api.mercadopago.com/v1/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          Authorization: `Bearer ${mpToken}`
        }
      }
    );

    const order = await mpResponse.json();

    if (!mpResponse.ok) {
      throw new Error("No se pudo consultar la orden.");
    }

    if (
      order.id !== orderId ||
      order.status !== "processed" ||
      order.status_detail !== "accredited"
    ) {
      return res.status(200).json({
        received: true,
        processed: false
      });
    }

    const currency = order.currency || order.currency_id;

    if (currency !== "ARS") {
      return res.status(200).json({
        received: true,
        processed: false
      });
    }

    const reservationId = order.external_reference;

    if (
      typeof reservationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(reservationId)
    ) {
      return res.status(200).json({
        received: true,
        processed: false
      });
    }

    const paidAmount = Number(order.total_paid_amount);
    const orderAmount = Number(order.total_amount);

    if (
      !Number.isFinite(paidAmount) ||
      !Number.isFinite(orderAmount) ||
      paidAmount <= 0 ||
      paidAmount !== orderAmount
    ) {
      return res.status(200).json({
        received: true,
        processed: false
      });
    }

    const payments = order.transactions?.payments || [];

    if (
      payments.length === 0 ||
      payments.some(payment =>
        payment.status !== "processed" ||
        payment.status_detail !== "accredited"
      )
    ) {
      return res.status(200).json({
        received: true,
        processed: false
      });
    }

    const accessToken = await getGoogleAccessToken();

    const result = await processReservation(
  accessToken,
  reservationId,
  orderId,
  paidAmount
);

    console.log("Resultado webhook ZEKA:", result);

    return res.status(200).json({
      received: true,
      ...result
    });

  } catch (error) {
    console.error("Error webhook ZEKA:", error);

    return res.status(500).json({
      error: "No se pudo procesar la notificación."
    });
  }
};

