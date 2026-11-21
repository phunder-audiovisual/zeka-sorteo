import { auth, db } from "./firebase.js";

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const ADMIN_UID = "GJe2WMAvJsdLtaaqfYT38fjJOVh1";

const $ = id => document.getElementById(id);

const loginForm = $("loginForm");
const loginSection = $("loginSection");
const dashboard = $("dashboard");
const loginMessage = $("loginMessage");
const raffleList = $("raffleList");

function money(value) {
  return Number(value || 0).toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  });
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  loginMessage.textContent = "Ingresando...";

  try {
    await signInWithEmailAndPassword(
      auth,
      $("email").value.trim(),
      $("password").value
    );
  } catch (error) {
    loginMessage.textContent = "Error: " + error.message;
  }
});

onAuthStateChanged(auth, async user => {
  if (user && user.uid === ADMIN_UID) {
    loginSection.hidden = true;
    dashboard.hidden = false;
    loginMessage.textContent = "";
    await loadRaffles();
    return;
  }

  dashboard.hidden = true;
  loginSection.hidden = false;

  if (user) {
    loginMessage.textContent = "Esta cuenta no tiene permisos de administrador.";
    await signOut(auth);
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

// CARGAR SORTEOS
async function loadRaffles() {
  raffleList.textContent = "Cargando sorteos...";

  try {
    const snapshot = await getDocs(collection(db, "raffles"));

    const raffles = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    raffles.sort((a, b) =>
      (b.createdAt?.toMillis?.() || 0) -
      (a.createdAt?.toMillis?.() || 0)
    );

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
      title.textContent = raffle.name || "Sorteo sin nombre";

      const info = document.createElement("p");
      info.textContent =
        `${raffle.quantity} números · ${money(raffle.price)} · ${raffle.winners} ganadores`;

      const status = document.createElement("p");
      status.textContent = "Estado: " + (raffle.status || "desconocido");

      const id = document.createElement("p");
      id.textContent = "ID: " + raffle.id;

      const syncButton = document.createElement("button");
      syncButton.type = "button";
      syncButton.textContent = "Sincronizar números públicos";
      syncButton.addEventListener("click", () => {
        syncPublicTickets(raffle);
      });

      const reservationsButton = document.createElement("button");
      reservationsButton.type = "button";
      reservationsButton.textContent = "Ver participantes y reservas";
      reservationsButton.style.marginLeft = "8px";
      reservationsButton.addEventListener("click", () => {
        loadReservations(raffle);
      });

      card.append(
        title,
        info,
        status,
        id,
        syncButton,
        reservationsButton
      );

                          // BOTÓN DEL SORTEO ZEKA
      if (
        raffle.id === "fHG7phVJcVHScDpuzx1B" &&
        raffle.status !== "drawn"
      ) {
        const drawButton = document.createElement("button");
        drawButton.type = "button";
        drawButton.textContent =
          raffle.status === "open"
            ? "Cerrar venta e iniciar sorteo"
            : "Realizar sorteo";

        drawButton.style.display = "block";
        drawButton.style.marginTop = "12px";

        drawButton.addEventListener("click", async () => {
          if (
            raffle.status === "open" &&
            !confirm("¿Querés cerrar la venta e iniciar el sorteo?")
          ) return;

          drawButton.disabled = true;

          try {
            const idToken = await auth.currentUser.getIdToken();

            async function callApi(url) {
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${idToken}`,
                  "Content-Type": "application/json"
                }
              });

              const text = await response.text();

              let data;
              try {
                data = JSON.parse(text);
              } catch {
                throw new Error(
                  `Error del servidor (${response.status}): ${text.slice(0, 200)}`
                );
              }

              if (!response.ok) {
                throw new Error(data.error || "Error en el servidor.");
              }

              return data;
            }

            if (raffle.status === "open") {
              await callApi("/api/close-raffle");
            }

            await callApi("/api/draw-raffle");

            alert("¡Sorteo realizado correctamente!");
            window.open("/ruleta.html", "_blank");
            await loadRaffles();

          } catch (error) {
            console.error(error);
            alert(error.message);
            drawButton.disabled = false;
          }
        });

        card.appendChild(drawButton);
      }

      raffleList.appendChild(card);
    });

  } catch (error) {
    console.error(error);
    raffleList.textContent =
      "Error cargando sorteos: " + error.message;
  }
}
