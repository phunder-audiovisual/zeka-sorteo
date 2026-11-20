
import { auth, db } from "./firebase.js";

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

import {
  collection,
  doc,
  writeBatch,
  getDocs,
  serverTimestamp,
  updateDoc,
  runTransaction
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

// ELEMENTOS
const $ = (id) => document.getElementById(id);

const loginSection = $("loginSection");
const dashboard = $("dashboard");
const loginForm = $("loginForm");
const logoutBtn = $("logoutBtn");
const raffleForm = $("raffleForm");

const emailInput = $("email");
const passwordInput = $("password");

const loginMessage = $("loginMessage");
const raffleMessage = $("raffleMessage");

const numberCount = $("numberCount");
const ticketPrice = $("ticketPrice");
const winnerCount = $("winnerCount");

const estimatedRevenue = $("estimatedRevenue");
const raffleList = $("raffleList");

let currentUser = null;

function money(value) {
  return "$" + Number(value).toLocaleString("es-AR");
}

// GUARDAR DOCUMENTOS EN LOTES
async function saveEntries(entries) {
  const chunkSize = 450;

  for (let i = 0; i < entries.length; i += chunkSize) {
    const batch = writeBatch(db);
    const chunk = entries.slice(i, i + chunkSize);

    chunk.forEach(entry => {
      batch.set(entry.ref, entry.data);
    });

    await batch.commit();
  }
}

// ACTUALIZAR RECAUDACIÓN
function updatePreview() {
  const total =
    Number(numberCount.value) *
    Number(ticketPrice.value || 0);

  estimatedRevenue.textContent = money(total);
}

numberCount.addEventListener("change", updatePreview);
ticketPrice.addEventListener("input", updatePreview);

// INICIAR SESIÓN
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  loginMessage.textContent = "Verificando acceso...";

  try {
    await signInWithEmailAndPassword(
      auth,
      emailInput.value.trim(),
      passwordInput.value
    );

    loginMessage.textContent = "";

  } catch (error) {
    loginMessage.textContent = "Error de acceso: " + error.message;
  }
});

// CERRAR SESIÓN
logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
});

// COMPROBAR SESIÓN
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (user) {
    loginSection.hidden = true;
    dashboard.hidden = false;
    await loadRaffles();
  } else {
    loginSection.hidden = false;
    dashboard.hidden = true;
  }
});

// CREAR SORTEO
raffleForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentUser) {
    raffleMessage.textContent = "Debés iniciar sesión.";
    return;
  }

  const name = $("raffleName").value.trim();
  const quantity = Number(numberCount.value);
  const price = Number(ticketPrice.value);
  const winners = Number(winnerCount.value);

  if (!name || ![100, 200, 300].includes(quantity)) {
    raffleMessage.textContent = "Datos incorrectos.";
    return;
  }

  if (!Number.isSafeInteger(price) || price < 1) {
    raffleMessage.textContent = "Precio inválido.";
    return;
  }

  if (!Number.isInteger(winners) || winners < 1 || winners > 3) {
    raffleMessage.textContent = "Cantidad de ganadores inválida.";
    return;
  }

  if (!confirm(
    `Crear "${name}" con ${quantity} números a ${money(price)} cada uno?`
  )) return;

  raffleMessage.textContent = "Creando sorteo y números...";

  try {
    const raffleRef = doc(collection(db, "raffles"));

    await saveEntries([{
      ref: raffleRef,
      data: {
        name,
        quantity,
        price,
        winners,
        status: "preparing",
        soldCount: 0,
        paidCount: 0,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp()
      }
    }]);

    const entries = [];

    for (let i = 1; i <= quantity; i++) {
      const number = String(i).padStart(3, "0");

      const privateRef = doc(
        db, "raffles", raffleRef.id, "tickets", number
      );

      entries.push({
        ref: privateRef,
        data: {
          number,
          status: "available",
          participantName: null,
          participantPhone: null,
          paid: false,
          createdAt: serverTimestamp()
        }
      });

      const publicRef = doc(
        db, "raffles", raffleRef.id, "publicTickets", number
      );

      entries.push({
        ref: publicRef,
        data: {
          number,
          status: "available"
        }
      });
    }

    await saveEntries(entries);

    await updateDoc(raffleRef, {
      status: "open"
    });

    raffleMessage.textContent =
      "¡Sorteo creado correctamente con números públicos!";

    raffleForm.reset();

    numberCount.value = "200";
    ticketPrice.value = "1000";
    winnerCount.value = "2";

    updatePreview();
    await loadRaffles();

  } catch (error) {
    console.error(error);
    raffleMessage.textContent =
      "Error al crear: " + error.message;
  }
});

// SINCRONIZAR NÚMEROS PÚBLICOS
async function syncPublicTickets(raffle) {
  if (!currentUser) return;

  const confirmSync = confirm(
    `¿Sincronizar los números de "${raffle.name}" conservando sus estados?`
  );

  if (!confirmSync) return;

  raffleMessage.textContent = "Sincronizando números...";

  try {
    const privateSnapshot = await getDocs(
      collection(db, "raffles", raffle.id, "tickets")
    );

    const entries = [];

    privateSnapshot.forEach(ticketDoc => {
      const ticket = ticketDoc.data();

      let status = "occupied";

      if (ticket.status === "available") {
        status = "available";
      } else if (ticket.status === "reserved") {
        status = "reserved";
      } else if (ticket.status === "paid" || ticket.paid === true) {
        status = "occupied";
      }

      const publicRef = doc(
        db,
        "raffles",
        raffle.id,
        "publicTickets",
        ticketDoc.id
      );

      entries.push({
        ref: publicRef,
        data: {
          number: String(ticket.number),
          status,
          reservationUid: ticket.reservationUid || null,
          expiresAt: ticket.expiresAt || null
        }
      });
    });

    if (entries.length !== Number(raffle.quantity)) {
      throw new Error("La cantidad de números privados no coincide.");
    }

    await saveEntries(entries);

    if (raffle.status === "preparing") {
      await updateDoc(doc(db, "raffles", raffle.id), {
        status: "open"
      });
    }

    raffleMessage.textContent =
      "¡Números sincronizados correctamente!";

    await loadRaffles();

  } catch (error) {
    console.error(error);
    raffleMessage.textContent =
      "Error al sincronizar: " + error.message;
  }
}

// LIBERAR RESERVAS VENCIDAS
async function expireReservation(reservation, raffle) {
  const reservationRef = doc(db, "reservations", reservation.id);

  await runTransaction(db, async (transaction) => {
    const reservationSnap = await transaction.get(reservationRef);

    if (!reservationSnap.exists()) return;

    const data = reservationSnap.data();

    const expiry = data.expiresAt?.toMillis?.();

    if (
      data.status !== "pending" ||
      data.raffleId !== raffle.id ||
      !expiry ||
      expiry > Date.now()
    ) {
      return;
    }

    const tickets = [];

    for (const number of data.numbers || []) {
      const numberId = String(number).padStart(3, "0");

      const privateRef = doc(
        db, "raffles", raffle.id, "tickets", numberId
      );

      const publicRef = doc(
        db, "raffles", raffle.id, "publicTickets", numberId
      );

      tickets.push({ privateRef, publicRef });
    }

    const snapshots = [];

    for (const ticket of tickets) {
      snapshots.push({
        privateSnap: await transaction.get(ticket.privateRef),
        publicSnap: await transaction.get(ticket.publicRef)
      });
    }

    for (let i = 0; i < tickets.length; i++) {
      const privateSnap = snapshots[i].privateSnap;

      if (
        privateSnap.exists() &&
        privateSnap.data().reservationId === reservation.id &&
        privateSnap.data().paid !== true
      ) {
        transaction.update(tickets[i].privateRef, {
          status: "available",
          participantName: null,
          participantPhone: null,
          reservationId: null,
          reservationUid: null,
          expiresAt: null,
          paid: false
        });

        if (snapshots[i].publicSnap.exists()) {
          transaction.update(tickets[i].publicRef, {
            status: "available",
            reservationUid: null,
            expiresAt: null
          });
        }
      }
    }

    transaction.update(reservationRef, {
      status: "expired"
    });
  });
}

// QUITAR UN NÚMERO DE UNA RESERVA
async function removeReservedNumber(reservation, raffle, number) {
  const numberId = String(number).padStart(3, "0");

  if (!confirm(`¿Eliminar el número ${numberId} de esta reserva?`)) {
    return;
  }

  try {
    const reservationRef = doc(db, "reservations", reservation.id);

    const privateRef = doc(
      db, "raffles", raffle.id, "tickets", numberId
    );

    const publicRef = doc(
      db, "raffles", raffle.id, "publicTickets", numberId
    );

    await runTransaction(db, async (transaction) => {
      const reservationSnap = await transaction.get(reservationRef);
      const privateSnap = await transaction.get(privateRef);
      const publicSnap = await transaction.get(publicRef);

      if (
        !reservationSnap.exists() ||
        !privateSnap.exists() ||
        !publicSnap.exists()
      ) {
        throw new Error("No se encontraron todos los documentos.");
      }

      const data = reservationSnap.data();
      const ticket = privateSnap.data();

      const expiry = data.expiresAt?.toMillis?.();

      if (
        data.status !== "pending" ||
        data.raffleId !== raffle.id ||
        !expiry ||
        expiry <= Date.now()
      ) {
        throw new Error("La reserva ya venció o no está pendiente.");
      }

      if (!(data.numbers || []).includes(Number(number))) {
        throw new Error("Ese número no pertenece a esta reserva.");
      }

      if (
        ticket.reservationId !== reservation.id ||
        ticket.status !== "reserved" ||
        ticket.paid === true
      ) {
        throw new Error("El número no pertenece a esta reserva o ya fue pagado.");
      }

      const remainingNumbers = data.numbers.filter(
        n => Number(n) !== Number(number)
      );

      transaction.update(privateRef, {
        status: "available",
        participantName: null,
        participantPhone: null,
        reservationId: null,
        reservationUid: null,
        expiresAt: null,
        paid: false
      });

      transaction.update(publicRef, {
        status: "available",
        reservationUid: null,
        expiresAt: null
      });

      transaction.update(reservationRef, {
        numbers: remainingNumbers,
        total: remainingNumbers.length * Number(raffle.price),
        status: remainingNumbers.length ? "pending" : "cancelled"
      });
    });

    alert(`El número ${numberId} fue eliminado correctamente.`);
    await loadReservations(raffle);

  } catch (error) {
    console.error("Error al quitar número:", error);
    alert("No se pudo quitar: " + error.message);
  }
}

// CONFIRMAR PAGO
async function confirmReservation(reservation, raffle) {
  if (!confirm("¿Confirmaste que recibiste el dinero de esta reserva?")) {
    return;
  }

  try {
    const reservationRef = doc(db, "reservations", reservation.id);

    await runTransaction(db, async (transaction) => {
      const reservationSnap = await transaction.get(reservationRef);

      if (!reservationSnap.exists()) {
        throw new Error("La reserva no existe.");
      }

      const data = reservationSnap.data();
      const expiry = data.expiresAt?.toMillis?.();

      if (
        data.status !== "pending" ||
        data.raffleId !== raffle.id
      ) {
        throw new Error("La reserva ya no está pendiente.");
      }

      if (!expiry || expiry <= Date.now()) {
        throw new Error("La reserva venció y no puede confirmarse.");
      }

      const tickets = [];

      for (const number of data.numbers || []) {
        const numberId = String(number).padStart(3, "0");

        const privateRef = doc(
          db, "raffles", raffle.id, "tickets", numberId
        );

        const publicRef = doc(
          db, "raffles", raffle.id, "publicTickets", numberId
        );

        tickets.push({ privateRef, publicRef });
      }

      const snapshots = [];

      for (const ticket of tickets) {
        snapshots.push({
          privateSnap: await transaction.get(ticket.privateRef),
          publicSnap: await transaction.get(ticket.publicRef)
        });
      }

      if (!tickets.length) {
        throw new Error("La reserva no tiene números.");
      }

      for (const item of snapshots) {
        if (
          !item.privateSnap.exists() ||
          !item.publicSnap.exists() ||
          item.privateSnap.data().reservationId !== reservation.id ||
          item.privateSnap.data().status !== "reserved" ||
          item.privateSnap.data().paid === true
        ) {
          throw new Error("Un número ya no pertenece a esta reserva.");
        }
      }

      for (const ticket of tickets) {
        transaction.update(ticket.privateRef, {
          status: "paid",
          paid: true
        });

        transaction.update(ticket.publicRef, {
          status: "occupied",
          expiresAt: null
        });
      }

      transaction.update(reservationRef, {
        status: "paid",
        paidAt: serverTimestamp()
      });
    });

    alert("¡Pago confirmado correctamente!");
    await loadReservations(raffle);

  } catch (error) {
    console.error(error);
    alert("No se pudo confirmar el pago: " + error.message);
  }
}

// RECHAZAR RESERVA
async function rejectReservation(reservation, raffle) {
  if (!confirm("¿Rechazar esta reserva y liberar sus números?")) {
    return;
  }

  try {
    const reservationRef = doc(db, "reservations", reservation.id);

    await runTransaction(db, async (transaction) => {
      const reservationSnap = await transaction.get(reservationRef);

      if (!reservationSnap.exists()) {
        throw new Error("La reserva no existe.");
      }

      const data = reservationSnap.data();

      if (
        data.status !== "pending" ||
        data.raffleId !== raffle.id
      ) {
        throw new Error("La reserva ya no está pendiente.");
      }

      const tickets = [];

      for (const number of data.numbers || []) {
        const numberId = String(number).padStart(3, "0");

        const privateRef = doc(
          db, "raffles", raffle.id, "tickets", numberId
        );

        const publicRef = doc(
          db, "raffles", raffle.id, "publicTickets", numberId
        );

        tickets.push({ privateRef, publicRef });
      }

      const snapshots = [];

      for (const ticket of tickets) {
        snapshots.push({
          privateSnap: await transaction.get(ticket.privateRef),
          publicSnap: await transaction.get(ticket.publicRef)
        });
      }

      for (let i = 0; i < tickets.length; i++) {
        const privateSnap = snapshots[i].privateSnap;

        if (
          privateSnap.exists() &&
          privateSnap.data().reservationId === reservation.id &&
          privateSnap.data().paid !== true
        ) {
          transaction.update(tickets[i].privateRef, {
            status: "available",
            participantName: null,
            participantPhone: null,
            reservationId: null,
            reservationUid: null,
            expiresAt: null,
            paid: false
          });

          if (snapshots[i].publicSnap.exists()) {
            transaction.update(tickets[i].publicRef, {
              status: "available",
              reservationUid: null,
              expiresAt: null
            });
          }
        }
      }

      transaction.update(reservationRef, {
        status: "rejected"
      });
    });

    alert("Reserva rechazada correctamente.");
    await loadReservations(raffle);

  } catch (error) {
    console.error(error);
    alert("No se pudo rechazar: " + error.message);
  }
}

// CARGAR RESERVAS Y PARTICIPANTES
async function loadReservations(raffle) {
  const container = $("reservationsList");

  container.textContent = "Consultando reservas...";

  try {
    console.log("UID administrador:", auth.currentUser?.uid);
console.log("UID esperado:", "GJe2WMAvJsdLtaaqfYT38fjJOVh1");
    let snapshot = await getDocs(
      collection(db, "reservations")
    );

    let reservations = snapshot.docs
      .map(item => ({
        id: item.id,
        ...item.data()
      }))
      .filter(item => item.raffleId === raffle.id);

    // Procesar vencimientos pendientes.
    for (const reservation of reservations) {
      const expiry = reservation.expiresAt?.toMillis?.();

      if (
        reservation.status === "pending" &&
        expiry &&
        expiry <= Date.now()
      ) {
        try {
          await expireReservation(reservation, raffle);
        } catch (error) {
          console.error("Error liberando reserva vencida:", error);
        }
      }
    }

    // Volver a consultar los estados actualizados.
    snapshot = await getDocs(
      collection(db, "reservations")
    );

    reservations = snapshot.docs
      .map(item => ({
        id: item.id,
        ...item.data()
      }))
      .filter(item => item.raffleId === raffle.id)
      .sort((a, b) => {
        const dateA = a.createdAt?.toMillis?.() || 0;
        const dateB = b.createdAt?.toMillis?.() || 0;
        return dateB - dateA;
      });

    container.replaceChildren();

    if (!reservations.length) {
      container.textContent = "Todavía no hay reservas.";
      return;
    }

    reservations.forEach(reservation => {
      const card = document.createElement("article");
      card.className = "stat-card";
      card.style.marginBottom = "12px";

      const title = document.createElement("h3");
      title.textContent = reservation.name || "Sin nombre";

      const phone = document.createElement("p");
      phone.textContent =
        "WhatsApp: " + (reservation.phone || "No disponible");

      const numbers = document.createElement("div");
      numbers.style.marginTop = "10px";

      const numbersTitle = document.createElement("p");
      numbersTitle.textContent = "Números:";
      numbers.appendChild(numbersTitle);

      (reservation.numbers || []).forEach(number => {
        const numberId = String(number).padStart(3, "0");

        const numberRow = document.createElement("div");
        numberRow.style.marginBottom = "8px";

        const numberText = document.createElement("span");
        numberText.textContent = numberId + " ";
        numberRow.appendChild(numberText);

        if (reservation.status === "pending") {
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.textContent = "Quitar";

          removeButton.addEventListener("click", async () => {
            removeButton.disabled = true;
            await removeReservedNumber(reservation, raffle, number);
          });

          numberRow.appendChild(removeButton);
        }

        numbers.appendChild(numberRow);
      });

      const total = document.createElement("p");
      total.textContent =
        "Total: " + money(reservation.total || 0);

      const status = document.createElement("p");
      status.textContent =
        "Estado: " + (reservation.status || "Desconocido");

      card.append(title, phone, numbers, total, status);

      if (reservation.status === "pending") {
        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.textContent = "Confirmar pago";
        confirmButton.style.marginRight = "8px";
        confirmButton.style.marginTop = "10px";

        confirmButton.addEventListener("click", async () => {
          confirmButton.disabled = true;
          await confirmReservation(reservation, raffle);
          confirmButton.disabled = false;
        });

        const rejectButton = document.createElement("button");
        rejectButton.type = "button";
        rejectButton.textContent = "Rechazar reserva";
        rejectButton.style.marginTop = "10px";

        rejectButton.addEventListener("click", async () => {
          rejectButton.disabled = true;
          await rejectReservation(reservation, raffle);
          rejectButton.disabled = false;
        });

        card.append(confirmButton, rejectButton);
      }

      container.appendChild(card);
    });

  } catch (error) {
    console.error("Error cargando reservas:", error);
    container.textContent =
      "Error al consultar reservas: " + error.message;
  }
}

// CARGAR SORTEOS
async function loadRaffles() {
  raffleList.textContent = "Cargando sorteos...";

  try {
    const snapshot = await getDocs(
      collection(db, "raffles")
    );

    const raffles = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    raffles.sort((a, b) => {
      const dateA = a.createdAt?.toMillis?.() || 0;
      const dateB = b.createdAt?.toMillis?.() || 0;
      return dateB - dateA;
    });

    $("totalRaffles").textContent = raffles.length;

    if (!raffles.length) {
      raffleList.textContent = "Todavía no hay sorteos creados.";
      return;
    }

    raffleList.replaceChildren();

    raffles.forEach(raffle => {
      const card = document.createElement("article");
      card.className = "stat-card";
      card.style.marginBottom = "12px";

      const title = document.createElement("h3");
      title.textContent = raffle.name;

      const info = document.createElement("p");
      info.style.marginTop = "10px";
      info.textContent =
        `${raffle.quantity} números · ${money(raffle.price)} · ${raffle.winners} ganadores`;

      const status = document.createElement("p");
      status.style.marginTop = "8px";
      status.textContent = "Estado: " + raffle.status;

      const id = document.createElement("small");
      id.textContent = "ID: " + raffle.id;

      const syncButton = document.createElement("button");
      syncButton.type = "button";
      syncButton.textContent = "Sincronizar números públicos";
      syncButton.style.marginTop = "12px";

      syncButton.addEventListener("click", async () => {
        syncButton.disabled = true;
        await syncPublicTickets(raffle);
        syncButton.disabled = false;
      });

      const reservationsButton = document.createElement("button");
      reservationsButton.type = "button";
      reservationsButton.textContent = "Ver participantes y reservas";
      reservationsButton.style.marginTop = "12px";

      reservationsButton.addEventListener("click", async () => {
        reservationsButton.disabled = true;
        await loadReservations(raffle);
        reservationsButton.disabled = false;
      });

      card.append(
        title,
        info,
        status,
        id,
        syncButton,
        reservationsButton
      );

      raffleList.appendChild(card);
    });

  } catch (error) {
    console.error(error);
    raffleList.textContent =
      "Error cargando sorteos: " + error.message;
  }
}

updatePreview();
