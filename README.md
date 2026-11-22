# ZEKA-SORTEO

Sitio de sorteos con números reservables, pago por Mercado Pago o transferencia,
panel de administración y ruleta en vivo.

- **Frontend:** HTML + JavaScript vanilla, Firebase Auth (anónimo para clientes)
  y Firestore.
- **Backend:** funciones de Vercel en `/api`, con acceso a Firestore mediante
  Workload Identity (sin claves en el repositorio).
- **Pagos:** Mercado Pago (API de Orders) + transferencias confirmadas a mano.

## Páginas

| Archivo | Para qué sirve |
| --- | --- |
| `index.html` + `app.js` | Página pública: elegir números, reservar y pagar |
| `admin.html` + `admin.js` | Panel del administrador |
| `ruleta.html` | Ruleta en vivo. Se abre desde el panel con `?raffle=ID` |

## Funciones de `/api`

| Función | Quién la usa | Qué hace |
| --- | --- | --- |
| `create-order` | Cliente | Crea la orden de Mercado Pago y alarga la reserva 20 min (una vez) |
| `report-payment` | Cliente | Registra "ya transferí" y reserva los números 3 horas |
| `mercadopago-webhook` | Mercado Pago | Confirma el pago (acepta pagos tardíos si los números siguen reservados) |
| `confirm-payment` | Admin | Confirma a mano una transferencia recibida |
| `close-raffle` | Admin | Cierra la venta de un sorteo |
| `draw-raffle` | Admin | Realiza el sorteo en el servidor |

El código compartido está en `lib/`.

## Cómo funciona el flujo

1. El cliente reserva números (15 min). El precio sale del sorteo.
2. **Mercado Pago:** `create-order` → pago → webhook confirma automáticamente.
3. **Transferencia (Naranja X / Cuenta DNI):** el cliente toca "Ya transferí";
   los números quedan reservados 3 horas y el administrador usa
   **Confirmar pago recibido** en *Reservas y participantes*.
4. El administrador **cierra la venta** y luego **realiza el sorteo**
   (hay que esperar o confirmar las reservas vigentes).
5. Si un pago de Mercado Pago no se puede asignar (por ejemplo, los números ya
   se liberaron), la reserva queda marcada con **⚠️ Pago con problema** en el
   panel para devolver el dinero.

Cada sorteo creado desde el panel funciona de forma independiente; la página
pública muestra el sorteo abierto (o cerrado) más reciente.

## Variables de entorno en Vercel

| Variable | Descripción |
| --- | --- |
| `GCP_PROJECT_ID` | ID del proyecto de Firebase/Google Cloud |
| `GCP_PROJECT_NUMBER` | Número del proyecto de Google Cloud |
| `GCP_SERVICE_ACCOUNT_EMAIL` | Cuenta de servicio con acceso a Firestore |
| `GCP_WORKLOAD_IDENTITY_POOL_ID` | Pool de Workload Identity |
| `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | Provider de Workload Identity |
| `FIREBASE_API_KEY` | API key web de Firebase (para verificar tokens) |
| `MP_ACCESS_TOKEN` | Access token de Mercado Pago |
| `MP_WEBHOOK_SECRET` | Clave secreta del webhook de Mercado Pago |
| `ADMIN_UID` | (Opcional) UID del administrador si cambia |

El webhook de Mercado Pago debe apuntar a
`https://TU-DOMINIO/api/mercadopago-webhook` (evento *Orders*).

## Reglas de Firestore

Las reglas **no están en este repositorio** y son la protección principal de
los datos. Los clientes (usuarios anónimos) solo deben poder:

- leer `raffles` y `publicTickets`;
- crear su propia reserva con `status: "pending"` y reservar números;
- **nunca** escribir `status: "paid"`, `paid: true` ni `paymentIssue`.

La confirmación de pagos, el cierre y el sorteo se hacen en `/api` con la cuenta
de servicio, que no depende de las reglas.

## Pruebas

```bash
npm test
```

Ejecuta 30 pruebas automáticas de reservas, pagos, webhook, cierre y sorteo con
un Firestore y un Mercado Pago simulados (no necesitan internet ni claves).
