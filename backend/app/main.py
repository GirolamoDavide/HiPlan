from contextlib import asynccontextmanager
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, Request
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.models.base import Base, engine
import app.models  # Assicura il caricamento di tutti i modelli per create_all
# pyrefly: ignore [missing-import]
from fastapi.staticfiles import StaticFiles
from app.api import (
    auth, users, projects, tasks, notes, export, 
    notifications, phase_templates, workload, vacations, 
    tickets, task_collaboration, websockets, settings as api_settings, activity_logs, todos, email_logs, search, replanning, chat, calendar, richieste_commerciali
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.db_migration_service import run_auto_migration
    async with engine.begin() as conn:
        # 1) Crea le tabelle nuove (non tocca quelle esistenti)
        await conn.run_sync(Base.metadata.create_all)
        # 2) Aggiunge automaticamente le colonne mancanti al DB esistente
        #    Garantisce che un DB vecchio venga aggiornato senza perdere dati
        await run_auto_migration(conn)

    from app.models.base import AsyncSessionLocal
    # pyrefly: ignore [missing-import]
    from sqlalchemy import select, func
    from app.models.user import User, UserRole
    from app.models.phase_template import PhaseTemplate
    from app.core.security import hash_password, verify_password

    async with AsyncSessionLocal() as session:
        # Check and seed PhaseTemplates
        count_res = await session.execute(select(func.count(PhaseTemplate.id)))
        if count_res.scalar_one() == 0:
            default_templates = [
                # Ufficio Tecnico
                ("Layout - Invio al cliente per approvazione", "ufficio_tecnico", "#3b82f6"),
                ("Approvazione cliente", "ufficio_tecnico", "#10b981"),
                ("Utenze elettriche", "ufficio_tecnico", "#f59e0b"),
                ("Calcolo strutturale", "ufficio_tecnico", "#84cc16"),
                ("Progettazione esecutiva - Messa in tavola - Codifica - Distinta base", "ufficio_tecnico", "#8b5cf6"),
                ("Targhette", "ufficio_tecnico", "#ec4899"),
                ("Documentazione tecnica (Manuali)", "ufficio_tecnico", "#d97706"),
                ("Certificati", "ufficio_tecnico", "#06b6d4"),
                ("Certificati - Approvazione Responsabile", "ufficio_tecnico", "#f43f5e"),
                ("Compilazione modulo check list", "ufficio_tecnico", "#e11d48"),
                ("Inserimento costi in Higest", "ufficio_tecnico", "#fb7185"),
                # Produzione
                ("Taglio lamiere laser", "produzione", "#ef4444"),
                ("Saldatura carpenteria", "produzione", "#f97316"),
                ("Verniciatura", "produzione", "#eab308"),
                ("Assemblaggio meccanico ed elettrico", "produzione", "#22c55e"),
                ("Assemblaggio finale", "produzione", "#14b8a6"),
                ("Collaudo interno", "produzione", "#06b6d4"),
                ("Imballo e preparazione spedizione", "produzione", "#3b82f6"),
                ("Spedizione al cliente", "produzione", "#6366f1"),
                # Acquisti
                ("Richiesta preventivi motoriduttori e componenti", "acquisti", "#8b5cf6"),
                ("Ordine materiale ferroso e lamiere", "acquisti", "#ec4899"),
                ("Ordine componentistica commerciale e pneumatica", "acquisti", "#f43f5e"),
                ("Attesa consegna materiali", "acquisti", "#64748b"),
                ("Controllo arrivo merce e smistamento", "acquisti", "#10b981"),
                ("Sollecito fornitori per ritardi", "acquisti", "#e11d48"),
                # Amministrazione
                ("Fatturazione", "amministrazione", "#64748b"),
                ("Gestione pagamenti", "amministrazione", "#475569"),
            ]
            for name, dept, col in default_templates:
                session.add(PhaseTemplate(name=name, department=dept, default_color=col, is_custom=False))
            await session.commit()
            print("[INIT] Inserite fasi preimpostate di default per tutti i reparti")

        result = await session.execute(select(User).where(func.lower(User.username) == "admin"))
        admin_user = result.scalar_one_or_none()
        if not admin_user:
            admin_user = User(
                email="admin@hiway.it",
                username="admin",
                hashed_password=hash_password("admin"),
                full_name="Amministratore HiWay",
                role=UserRole.ADMIN,
                department="admin",
                is_active=True
            )
            session.add(admin_user)
            await session.commit()
            print("[INIT] Creato utente admin predefinito (username: admin / password: admin)")
        else:
            if not verify_password("admin", str(admin_user.hashed_password)): # type: ignore
                admin_user.hashed_password = hash_password("admin") # type: ignore
                await session.commit()
                print("[INIT] Password utente admin sincronizzata a 'admin'")

    # pyrefly: ignore [missing-import]
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from app.services.backup_service import run_backup

    scheduler = AsyncIOScheduler()
    scheduler.add_job(run_backup, 'cron', hour=20, minute=0)

    # Scheduler: invia notifiche TODO regolarmente controllando la data e ora esatta
    async def run_todo_notifications():
        from app.models.base import AsyncSessionLocal
        from app.models.todo import Todo
        from app.models.notification import Notification, NotificationType
        from app.models.user import User
        from app.services.email_service import send_todo_notification_email
        import json
        from datetime import datetime, timedelta
        # pyrefly: ignore [missing-import]
        from sqlalchemy import select

        now = datetime.now()
        tomorrow_now = now + timedelta(days=1)

        async with AsyncSessionLocal() as session:
            # Leggi l'email di notifica default configurata dall'admin
            from app.models.setting import Setting as AppSetting
            default_email_res = await session.execute(
                select(AppSetting).where(AppSetting.key == "todo_notification_email")
            )
            default_email_setting = default_email_res.scalar_one_or_none()
            default_notification_email = (default_email_setting.value or "").strip() if default_email_setting else ""

            # 1) Invia notifica se notify_date è passato e non ancora inviato
            todos_notify = await session.execute(
                select(Todo).where(
                    Todo.notify_date <= now,
                    Todo.is_completed == False,
                    Todo.notify_sent == False,
                    Todo.deleted_at.is_(None),
                )
            )
            for todo in todos_notify.scalars().all():
                todo.notify_sent = True # type: ignore
                try:
                    assignees = json.loads(str(todo.assignees)) if todo.assignees else []
                except Exception:
                    assignees = []

                # Notifica in-app (con controllo anti-duplicati)
                for uid in assignees:
                    existing_notif = await session.execute(
                        select(Notification).where(
                            Notification.user_id == uid,
                            Notification.title == f"📋 TODO: {todo.title}",
                            Notification.is_read == False,
                        )
                    )
                    if not existing_notif.scalar_one_or_none():
                        notif = Notification(
                            user_id=uid,
                            title=f"📋 TODO: {todo.title}",
                            message="Data di notifica raggiunta per il tuo TODO.",
                            type=NotificationType.TODO,
                            link=f"/todo?id={todo.id}",
                        )
                        session.add(notif)

                # Email: invia sempre se c'è notify_date (notify_email=True impostato dal frontend)
                if todo.notify_email:
                    users_res = await session.execute(
                        select(User).where(User.id.in_(assignees), User.is_active == True)
                    )
                    users_list = users_res.scalars().all()
                    emails = [u.email for u in users_list if u.email]
                    # Aggiungi email default admin se configurata e non già presente
                    if default_notification_email and default_notification_email not in emails:
                        emails.append(default_notification_email) # type: ignore
                    creator_res = await session.execute(select(User).where(User.id == todo.creator_id))
                    creator = creator_res.scalar_one_or_none()
                    if emails:
                        await send_todo_notification_email(
                            to_addresses=emails, # type: ignore
                            todo_title=str(todo.title),
                            todo_content=str(todo.content) if todo.content else None,
                            creator_name=str(creator.full_name or creator.username) if creator else "HiPlan",
                            notify_type="notification",
                        )

            await session.commit()

            # 2) Invia reminder scadenza se manca <= 24 ore e non ancora inviato
            todos_due = await session.execute(
                select(Todo).where(
                    Todo.due_date <= tomorrow_now,
                    Todo.is_completed == False,
                    Todo.due_reminder_sent == False,
                    Todo.deleted_at.is_(None),
                )
            )
            for todo in todos_due.scalars().all():
                todo.due_reminder_sent = True # type: ignore
                try:
                    assignees = json.loads(str(todo.assignees)) if todo.assignees else []
                except Exception:
                    assignees = []

                # Notifica in-app (con controllo anti-duplicati)
                for uid in assignees:
                    existing_due = await session.execute(
                        select(Notification).where(
                            Notification.user_id == uid,
                            Notification.title == f"⏰ Scadenza domani: {todo.title}",
                            Notification.is_read == False,
                        )
                    )
                    if not existing_due.scalar_one_or_none():
                        notif = Notification(
                            user_id=uid,
                            title=f"⏰ Scadenza domani: {todo.title}",
                            message="Un TODO non ancora completato è in scadenza domani.",
                            type=NotificationType.DEADLINE,
                            link=f"/todo?id={todo.id}",
                        )
                        session.add(notif)

                # Email scadenza (invia se notify_email=True, ovvero se ha una due_date)
                if todo.notify_email:
                    users_res = await session.execute(
                        select(User).where(User.id.in_(assignees), User.is_active == True)
                    )
                    users_list = users_res.scalars().all()
                    emails = [u.email for u in users_list if u.email]
                    # Aggiungi email default admin se configurata e non già presente
                    if default_notification_email and default_notification_email not in emails:
                        emails.append(default_notification_email) # type: ignore
                    creator_res = await session.execute(select(User).where(User.id == todo.creator_id))
                    creator = creator_res.scalar_one_or_none()
                    if emails:
                        await send_todo_notification_email(
                            to_addresses=emails, # type: ignore
                            todo_title=str(todo.title),
                            todo_content=str(todo.content) if todo.content else None,
                            creator_name=str(creator.full_name or creator.username) if creator else "HiPlan",
                            notify_type="due_reminder",
                        )

            await session.commit()

    async def run_calendar_notifications():
        from app.models.base import AsyncSessionLocal
        from app.models.calendar_event import CalendarEvent
        from app.models.user import User
        from app.services.email_service import send_calendar_reminder_email
        import json
        from datetime import datetime
        # pyrefly: ignore [missing-import]
        from sqlalchemy import select, or_

        now = datetime.now()

        async with AsyncSessionLocal() as session:
            # Eventi da notificare
            events_to_notify = await session.execute(
                select(CalendarEvent).where(
                    CalendarEvent.reminder_sent == False,
                    CalendarEvent.reminder_type != "none",
                    CalendarEvent.reminder_time <= now
                )
            )
            for ev in events_to_notify.scalars().all():
                ev.reminder_sent = True # type: ignore
                
                # Trova utenti a cui notificare: autore + condivisi
                try:
                    shared = json.loads(str(ev.shared_with)) if ev.shared_with else []
                except:
                    shared = []
                
                users_res = await session.execute(
                    select(User).where(
                        or_(
                            User.id == ev.user_id,
                            User.username.in_(shared)
                        ),
                        User.is_active == True
                    )
                )
                users_list = users_res.scalars().all()
                emails = [u.email for u in users_list if u.email]
                
                creator = next((u for u in users_list if u.id == ev.user_id), None)
                if not creator:
                    creator_res = await session.execute(select(User).where(User.id == ev.user_id))
                    creator = creator_res.scalar_one_or_none()

                if emails:
                    await send_calendar_reminder_email(
                        to_addresses=emails, # type: ignore
                        event_title=str(ev.title),
                        event_description=str(ev.description) if ev.description else None,
                        event_start_date=ev.start_date, # type: ignore
                        creator_name=str(creator.full_name or creator.username) if creator else "HiPlan"
                    )

            await session.commit()

    # Scheduler: Generazione report AI giornaliero alle ore 7:00
    async def run_daily_ai_report():
        try:
            from app.models.base import AsyncSessionLocal
            from app.services.chat_service import chat_service
            async with AsyncSessionLocal() as session:
                await chat_service.generate_admin_report(session)
                print("[SCHEDULER] Report AI giornaliero delle ore 07:00 generato con successo.")
        except Exception as e:
            print(f"[SCHEDULER] Errore generazione report AI ore 07:00: {e}")

    # Scheduler: Pulizia automatica definitiva del cestino (> 90 giorni) alle ore 03:00
    async def run_daily_trash_purge():
        try:
            from app.models.base import AsyncSessionLocal
            from app.services.project_service import purge_expired_trash as purge_projects
            from app.api.todos import purge_expired_todo_trash
            from app.api.tickets import purge_expired_ticket_trash
            from app.api.notes import purge_expired_note_trash
            async with AsyncSessionLocal() as session:
                await purge_projects(session)
                await purge_expired_todo_trash(session)
                await purge_expired_ticket_trash(session)
                await purge_expired_note_trash(session)
                print("[SCHEDULER] Pulizia automatica cestino (> 90 giorni) completata con successo.")
        except Exception as e:
            print(f"[SCHEDULER] Errore pulizia automatica cestino: {e}")

    scheduler.add_job(run_daily_trash_purge, 'cron', hour=3, minute=0)
    scheduler.add_job(run_daily_ai_report, 'cron', hour=7, minute=0)
    scheduler.add_job(run_todo_notifications, 'interval', minutes=5)
    scheduler.add_job(run_calendar_notifications, 'interval', minutes=5)
    scheduler.start()
    print("[INIT] Scheduler avviato (Report AI ore 07:00, pulizia Cestino 90gg ore 03:00, controllo TODO ed Eventi ogni 5 minuti)")

    yield
    await engine.dispose()

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="Software di Project Management con Diagrammi di Gantt",
    lifespan=lifespan,
)

# Serviamo la cartella uploads
import os
os.makedirs("uploads", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list + [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"https?://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_api_middleware(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(projects.router)
app.include_router(tasks.router)
app.include_router(task_collaboration.router)
app.include_router(workload.router)
app.include_router(notifications.router)
app.include_router(api_settings.router)
app.include_router(export.router)
app.include_router(notes.router)
app.include_router(vacations.router)
app.include_router(phase_templates.router)
app.include_router(tickets.router)
app.include_router(activity_logs.router)
app.include_router(websockets.router)
app.include_router(todos.router)
app.include_router(email_logs.router, prefix="/api/admin/email-logs", tags=["Admin"])
app.include_router(search.router)
app.include_router(replanning.router)
app.include_router(chat.router, prefix="/api/chat", tags=["Chat"])
app.include_router(calendar.router, prefix="/api/calendar", tags=["Calendar"])
app.include_router(richieste_commerciali.router)

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": settings.APP_NAME}
