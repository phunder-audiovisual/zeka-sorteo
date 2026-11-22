"use strict";

const {
  DOCS,
  ROOT,
  ID_PATTERN,
  HttpError,
  verifyAdmin,
  getGoogleAccessToken,
  firestoreRequest
} = require("../lib/google");

// Elimina un sorteo completo (solo administrador): sus números, los números
// públicos, las reservas que lo mencionan y, al final, el sorteo en sí.
// El sorteo se borra último: si algo se interrumpe, sigue visible en el panel
// y se puede volver a tocar "Eliminar".

const PAGE_SIZE = 300;
const MAX_PAGES = 500;
const TIME_BUDGET_MS = 40 * 1000;
const CONFIRM_WORD = "ELIMINAR";

class OutOfTime extends Error {}

function checkTime(state) {
  if (Date.now() > state.deadline) throw new OutOfTime();
}

async function deleteNames(names, token, state) {
  for (let i = 0; i < names.length; i += 400) {
    const chunk = names.slice(i, i + 400);

    await firestoreRequest(`${ROOT}:commit`, token, {
      method: "POST",
      body: JSON.stringify({ writes: chunk.map(name => ({ delete: name })) })
    });

    state.deleted += chunk.length;
  }
}

async function listCollectionIds(docUrl, token) {
  const ids = [];
  let pageToken = null;

  do {
    const result = await firestoreRequest(`${docUrl}:listCollectionIds`, token, {
      method: "POST",
      body: JSON.stringify({
        pageSize: 100,
        ...(pageToken ? { pageToken } : {})
      })
    });

    ids.push(...(result.collectionIds || []));
    pageToken = result.nextPageToken || null;
  } while (pageToken);

  return ids;
}

// Vacía una subcolección del sorteo, de a tandas.
async function deleteSubcollection(raffleUrl, collectionId, token, state) {
  for (let page = 0; page < MAX_PAGES; page++) {
    checkTime(state);

    const result = await firestoreRequest(
      `${raffleUrl}/${encodeURIComponent(collectionId)}?pageSize=${PAGE_SIZE}`,
      token
    );

    const documents = result.documents || [];

    if (documents.length === 0) return;

    await deleteNames(documents.map(document => document.name), token, state);
  }
}

// Las reservas viven en una colección aparte y apuntan al sorteo con raffleId.
async function deleteReservations(raffleId, token, state) {
  for (let page = 0; page < MAX_PAGES; page++) {
    checkTime(state);

    const result = await firestoreRequest(`${ROOT}:runQuery`, token, {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "reservations" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "raffleId" },
              op: "EQUAL",
              value: { stringValue: raffleId }
            }
          },
          limit: PAGE_SIZE
        }
      })
    });

    const names = (Array.isArray(result) ? result : [result])
      .filter(item => item.document)
      .map(item => item.document.name);

    if (names.length === 0) return;

    await deleteNames(names, token, state);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const admin = await verifyAdmin(req);

    if (!admin.valid) {
      return res.status(admin.status).json({
        error: admin.status === 403
          ? "No estás autorizado para eliminar sorteos."
          : "Debés iniciar sesión como administrador."
      });
    }

    const raffleId = req.body?.raffleId;

    if (typeof raffleId !== "string" || !ID_PATTERN.test(raffleId)) {
      return res.status(400).json({ error: "ID de sorteo no válido." });
    }

    if (req.body?.confirm !== CONFIRM_WORD) {
      return res.status(400).json({
        error: `Falta la confirmación (${CONFIRM_WORD}).`
      });
    }

    const token = await getGoogleAccessToken();
    const raffleUrl = `${ROOT}/raffles/${raffleId}`;

    try {
      await firestoreRequest(raffleUrl, token);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return res.status(404).json({ error: "No se encontró el sorteo." });
      }
      throw error;
    }

    const state = { deleted: 0, deadline: Date.now() + TIME_BUDGET_MS };

    try {
      const collectionIds = await listCollectionIds(raffleUrl, token);

      for (const collectionId of collectionIds) {
        await deleteSubcollection(raffleUrl, collectionId, token, state);
      }

      await deleteReservations(raffleId, token, state);

      await deleteNames(
        [`${DOCS}/raffles/${raffleId}`],
        token,
        state
      );
    } catch (error) {
      if (error instanceof OutOfTime) {
        console.error(
          `Eliminando sorteo ${raffleId}: tiempo agotado tras borrar ${state.deleted} documentos.`
        );

        return res.status(200).json({
          success: true,
          complete: false,
          message:
            "Se borró una parte del sorteo, pero faltan datos. Tocá Eliminar otra vez para terminar."
        });
      }

      throw error;
    }

    console.log(
      `Sorteo ${raffleId} eliminado por el administrador (${state.deleted} documentos).`
    );

    return res.status(200).json({
      success: true,
      complete: true,
      message: "Sorteo eliminado correctamente."
    });
  } catch (error) {
    console.error("Error eliminando sorteo:", error);

    return res.status(500).json({ error: "No se pudo eliminar el sorteo." });
  }
};
