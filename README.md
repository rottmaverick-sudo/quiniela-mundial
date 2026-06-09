# Quiniela Mundial 2026

App de quiniela con usuarios, contrasenas y SQLite.

## Correr local

```powershell
python server.py
```

Abre `http://localhost:8000`.

El primer usuario que crees se vuelve administrador. El admin puede editar partidos, resultados y la URL de resultados.

## Base de datos

La base local se crea en `data/quiniela.sqlite`.

## Subir a nube

Opcion recomendada para empezar: Render.

1. Sube esta carpeta a GitHub.
2. En Render, crea un `New Web Service`.
3. Conecta el repositorio.
4. Usa:
   - Runtime: Python
   - Build Command: vacio
   - Start Command: `python server.py`
5. Abre la URL que Render te asigne.
6. Crea el primer usuario: ese usuario sera admin.

Render tambien puede leer `render.yaml`.

Nota importante: en un servicio gratuito sin disco persistente, SQLite puede perder datos al redeploy o reinicio. Para una quiniela real con muchas personas conviene contratar disco persistente o mover la base a Supabase/Postgres.

## Como se parece a una quiniela real

- Registro e inicio de sesion por participante.
- Pronostico por marcador.
- Ranking general.
- Puntos por marcador exacto o tendencia.
- Admin para capturar resultados y editar partidos.
- URL de resultados para refrescar marcadores desde una API externa.
