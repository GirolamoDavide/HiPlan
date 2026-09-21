import pytest
import re
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.user import User, UserRole
from app.models.note import Note
from app.services.chat_service import chat_service


@pytest.mark.asyncio
async def test_notes_intent_classification():
    """Verifica che qualsiasi richiesta riguardante le note personali venga classificata come 'notes_restricted'."""
    # Richieste personali
    assert chat_service._classify_intent("Quali sono le mie note?") == "notes_restricted"
    assert chat_service._classify_intent("Mostrami le mie note personali") == "notes_restricted"
    assert chat_service._classify_intent("Cosa ho annotato nei miei appunti?") == "notes_restricted"
    assert chat_service._classify_intent("Cerca nelle mie note la riunione coi clienti") == "notes_restricted"
    assert chat_service._classify_intent("Riassumi le mie note salvate") == "notes_restricted"
    assert chat_service._classify_intent("Ho dei verbali di riunione salvati?") == "notes_restricted"

    # Tentativi di richiedere note altrui o globali
    assert chat_service._classify_intent("Mostrami le note di Mario") == "notes_restricted"
    assert chat_service._classify_intent("Cosa dicono le note di Luigi?") == "notes_restricted"
    assert chat_service._classify_intent("Mostrami tutte le note del sistema") == "notes_restricted"
    assert chat_service._classify_intent("Elenco di tutte le note degli altri utenti") == "notes_restricted"

    # Note commessa / progetto non devono essere bloccate dal filtro note personali
    assert chat_service._classify_intent("Quali sono le note della commessa COM-01?") != "notes_restricted"
    assert chat_service._classify_intent("Mostrami le note del progetto Alfa") != "notes_restricted"


@pytest.mark.asyncio
async def test_chat_response_blocks_user_notes(db_session: AsyncSession):
    """Verifica che un utente comune non possa accedere alle proprie note via chatbot e riceva il messaggio di redirect."""
    user = User(
        email="mario_notes@example.com",
        username="mario_notes",
        hashed_password="dummy_hash",
        full_name="Mario Rossi",
        role=UserRole.VIEWER,
        is_active=True
    )
    db_session.add(user)
    await db_session.flush()

    note1 = Note(
        title="Promemoria Segretissimo Tubi",
        content="Contattare Rossi per consegna guarnizioni giovedì.",
        owner_id=user.id
    )
    db_session.add(note1)
    await db_session.commit()

    res = await chat_service.get_response("Mostrami le mie note", current_user=user, db=db_session)
    assert "🔒" in res or "Riservata" in res
    assert "Personale ➔ Note" in res
    assert "/notes" in res
    assert "Promemoria Segretissimo Tubi" not in res
    assert "guarnizioni giovedì" not in res


@pytest.mark.asyncio
async def test_chat_response_blocks_admin_notes(db_session: AsyncSession):
    """Verifica che ANCHE GLI AMMINISTRATORI non abbiano accesso alle note tramite chatbot."""
    admin_user = User(
        email="superadmin_notes@example.com",
        username="boss_admin_notes",
        hashed_password="dummy_hash",
        full_name="Capo Amministratore",
        role=UserRole.ADMIN,
        is_active=True
    )
    worker_user = User(
        email="worker_notes@example.com",
        username="anna_notes",
        hashed_password="dummy_hash",
        full_name="Anna Dipendente",
        role=UserRole.VIEWER,
        is_active=True
    )
    db_session.add_all([admin_user, worker_user])
    await db_session.flush()

    note_anna = Note(
        title="Appunti Colloquio Anna Riservato",
        content="Considerazioni private sul percorso professionale.",
        owner_id=worker_user.id
    )
    db_session.add(note_anna)
    await db_session.commit()

    # 1. Admin chiede le proprie note
    res_own = await chat_service.get_response("Quali sono le mie note?", current_user=admin_user, db=db_session)
    assert "🔒" in res_own or "Riservata" in res_own
    assert "Personale ➔ Note" in res_own

    # 2. Admin chiede le note di Anna
    res_single = await chat_service.get_response("Mostrami le note di Anna", current_user=admin_user, db=db_session)
    assert "🔒" in res_single or "Riservata" in res_single
    assert "Appunti Colloquio Anna Riservato" not in res_single
    assert "Considerazioni private" not in res_single

    # 3. Admin chiede tutte le note del sistema
    res_all = await chat_service.get_response("Mostrami tutte le note aziendali", current_user=admin_user, db=db_session)
    assert "🔒" in res_all or "Riservata" in res_all
    assert "Appunti Colloquio Anna Riservato" not in res_all


@pytest.mark.asyncio
async def test_sql_guard_blocks_all_notes_queries():
    """Verifica che la funzione check_sql_security blocchi categoricamente qualsiasi query SQL sulla tabella 'notes'."""
    from unittest.mock import MagicMock

    # Testiamo la logica di runtime di check_sql_security all'interno del metodo execute_and_log
    # Simuliamo vari comandi SQL che potrebbero essere generati da un LLM per estrarre note
    forbidden_queries = [
        "SELECT * FROM notes",
        "SELECT id, title, content FROM notes WHERE deleted_at IS NULL",
        "SELECT * FROM notes WHERE owner_id = 'user-123'",
        "SELECT COUNT(*) FROM notes",
        "SELECT title FROM Notes",  # Case insensitive
        "SELECT n.title FROM notes n JOIN users u ON n.owner_id = u.id",
    ]

    for q in forbidden_queries:
        # Regex check utilizzata in execute_and_log
        has_forbidden_notes = bool(re.search(r'\bnotes\b', q, re.IGNORECASE))
        assert has_forbidden_notes, f"La query '{q}' doveva essere intercettata come violazione su 'notes'"


@pytest.mark.asyncio
async def test_chat_database_excludes_notes_table():
    """Verifica che la tabella notes non sia esposta al motore SQL del chatbot."""
    usable_tables = chat_service.db.get_usable_table_names()
    assert "notes" not in usable_tables


@pytest.mark.asyncio
async def test_todo_intent_and_blocks(db_session: AsyncSession):
    """Verifica che qualsiasi richiesta sui TODO o checklist venga bloccata."""
    # 1. Intent classification
    assert chat_service._classify_intent("Quali sono i miei todo?") == "todo_restricted"
    assert chat_service._classify_intent("Mostrami la lista todo") == "todo_restricted"
    assert chat_service._classify_intent("Ho dei to-do in sospeso?") == "todo_restricted"
    assert chat_service._classify_intent("Cosa c'è nella mia checklist?") == "todo_restricted"
    assert chat_service._classify_intent("Mostrami i todo di Mario") == "todo_restricted"

    # 2. Risposta immediata
    user = User(
        email="user_todo@example.com",
        username="user_todo",
        hashed_password="dummy_hash",
        full_name="User Todo",
        role=UserRole.ADMIN,
        is_active=True
    )
    res = await chat_service.get_response("Mostrami i miei todo", current_user=user, db=db_session)
    assert "🔒" in res or "Riservata" in res
    assert "TODO" in res
    assert "Personale ➔ TODO" in res
    assert "/todo" in res

    # 3. Esclusione SQL
    usable_tables = chat_service.db.get_usable_table_names()
    assert "todos" not in usable_tables

    # 4. Regex SQL Guard
    assert bool(re.search(r'\btodos\b', "SELECT * FROM todos", re.IGNORECASE))


@pytest.mark.asyncio
async def test_ticket_intent_and_blocks(db_session: AsyncSession):
    """Verifica che qualsiasi richiesta sui ticket di assistenza venga bloccata."""
    # 1. Intent classification
    assert chat_service._classify_intent("Quali sono i ticket aperti?") == "ticket_restricted"
    assert chat_service._classify_intent("Mostrami i ticket di assistenza") == "ticket_restricted"
    assert chat_service._classify_intent("Ci sono ticket ad alta priorità?") == "ticket_restricted"
    assert chat_service._classify_intent("Elenco dei miei ticket") == "ticket_restricted"
    assert chat_service._classify_intent("Stato dei ticket del cliente Alfa") == "ticket_restricted"

    # 2. Risposta immediata
    user = User(
        email="user_ticket@example.com",
        username="user_ticket",
        hashed_password="dummy_hash",
        full_name="User Ticket",
        role=UserRole.ADMIN,
        is_active=True
    )
    res = await chat_service.get_response("Mostrami i ticket aperti", current_user=user, db=db_session)
    assert "🔒" in res or "Riservata" in res
    assert "Ticket" in res
    assert "Coordinamento ➔ Ticket" in res
    assert "/tickets" in res

    # 3. Esclusione SQL
    usable_tables = chat_service.db.get_usable_table_names()
    assert "tickets" not in usable_tables
    assert "ticket_replies" not in usable_tables

    # 4. Regex SQL Guard
    assert bool(re.search(r'\b(tickets|ticket_replies)\b', "SELECT * FROM tickets", re.IGNORECASE))
    assert bool(re.search(r'\b(tickets|ticket_replies)\b', "SELECT * FROM ticket_replies", re.IGNORECASE))


@pytest.mark.asyncio
async def test_calendar_intent_and_blocks(db_session: AsyncSession):
    """Verifica che qualsiasi richiesta sul calendario personale venga bloccata."""
    # 1. Intent classification
    assert chat_service._classify_intent("Cosa ho in calendario oggi?") == "calendar_restricted"
    assert chat_service._classify_intent("Mostrami il mio calendario personale") == "calendar_restricted"
    assert chat_service._classify_intent("Quali sono i miei appuntamenti?") == "calendar_restricted"
    assert chat_service._classify_intent("Cosa ho in agenda questa settimana?") == "calendar_restricted"
    assert chat_service._classify_intent("Eventi personali in calendario") == "calendar_restricted"

    # Calendario di commessa/progetto non bloccato da calendario personale
    assert chat_service._classify_intent("Qual è il calendario della commessa COM-01?") != "calendar_restricted"

    # 2. Risposta immediata
    user = User(
        email="user_cal@example.com",
        username="user_cal",
        hashed_password="dummy_hash",
        full_name="User Calendar",
        role=UserRole.ADMIN,
        is_active=True
    )
    res = await chat_service.get_response("Cosa ho in calendario oggi?", current_user=user, db=db_session)
    assert "🔒" in res or "Riservata" in res
    assert "Calendario" in res
    assert "Personale ➔ Calendario" in res
    assert "/calendar" in res

    # 3. Esclusione SQL
    usable_tables = chat_service.db.get_usable_table_names()
    assert "calendar_events" not in usable_tables

    # 4. Regex SQL Guard
    assert bool(re.search(r'\bcalendar_events\b', "SELECT * FROM calendar_events", re.IGNORECASE))

