"""
Servizio email asincrono per le notifiche dei TODO.
Usa aiosmtplib per inviare email tramite SMTP aziendale.
"""
from datetime import date, datetime
import logging
from typing import List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)


async def send_email(
    to_addresses: List[str],
    subject: str,
    body_html: str,
    body_text: Optional[str] = None,
) -> bool:
    """
    Invia una email a una lista di destinatari.
    Restituisce True se l'invio ha avuto successo, False altrimenti.
    """
    if not settings.SMTP_HOST or not settings.SMTP_USER:
        logger.warning("[EMAIL] Configurazione SMTP non impostata — email non inviata.")
        return False

    if not to_addresses:
        return False

    try:
        # pyrefly: ignore [missing-import]
        import aiosmtplib
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = settings.SMTP_FROM or settings.SMTP_USER
        msg["To"] = ", ".join(to_addresses)

        if body_text:
            msg.attach(MIMEText(body_text, "plain", "utf-8"))
        msg.attach(MIMEText(body_html, "html", "utf-8"))

        is_ssl_port = settings.SMTP_PORT == 465
        await aiosmtplib.send(
            msg,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USER,
            password=settings.SMTP_PASSWORD,
            use_tls=is_ssl_port,
            start_tls=settings.SMTP_USE_TLS if not is_ssl_port else False,
        )
        logger.info(f"[EMAIL] Email inviata a {to_addresses} — soggetto: {subject}")
        await _log_email(to_addresses, subject, "success")
        return True

    except Exception as e:
        logger.error(f"[EMAIL] Errore invio email a {to_addresses}: {e}")
        await _log_email(to_addresses, subject, "error", str(e))
        return False

async def _log_email(to_addresses: List[str], subject: str, status: str, error_message: Optional[str] = None):
    try:
        from app.models.base import AsyncSessionLocal
        from app.models.email_log import EmailLog
        
        async with AsyncSessionLocal() as db:
            log = EmailLog(
                recipient=", ".join(to_addresses),
                subject=subject,
                status=status,
                error_message=error_message
            )
            db.add(log)
            await db.commit()
    except Exception as e:
        logger.error(f"[EMAIL_LOG] Errore salvataggio log: {e}")


async def send_todo_notification_email(
    to_addresses: List[str],
    todo_title: str,
    todo_content: Optional[str],
    creator_name: str,
    notify_type: str = "notification",  # "notification" | "due_reminder"
    todo_due_date: Optional[date] = None,
) -> bool:
    """Invia la email di notifica TODO."""
    if notify_type == "due_reminder":
        subject = f"HiPlan: {todo_title}"
        intro = "Il seguente TODO è in scadenza <strong>domani</strong> e non è ancora stato completato."
    else:
        subject = f"HiPlan: {todo_title}"
        intro = f"Hai ricevuto un nuovo TODO da <strong>{creator_name}</strong>."

    content_html = f"<p style='white-space: pre-wrap; margin-top: 12px;'>{todo_content}</p>" if todo_content else ""
    date_html = f"<p style='margin-top: 12px; font-size: 0.9rem; color: #ef4444;'><strong>📅 Scadenza:</strong> {todo_due_date.strftime('%d/%m/%Y')}</p>" if todo_due_date else ""

    body_html = f"""
    <html><body style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 40px 20px;">
        <div style="max-width: 650px; margin: auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); overflow: hidden;">
            <div style="padding: 24px 32px 32px 32px;">
                <p style="font-size: 1.05rem; line-height: 1.6; margin-top: 0; margin-bottom: 8px;">{intro}</p>
                <div style="background: #f8fafc; border-left: 5px solid #2563eb; border-radius: 6px; padding: 24px; margin: 12px 0;">
                    <h2 style="margin: 0 0 12px 0; font-size: 1.3rem; color: #0f172a;">{todo_title}</h2>
                    {content_html}
                    {date_html}
                </div>
                <p style="color: #64748b; font-size: 0.9rem; border-top: 1px solid #e2e8f0; padding-top: 24px;">Accedi a HiPlan per visualizzare il dettaglio e gestire il TODO.</p>
            </div>
            <div style="background-color: #f1f5f9; padding: 24px; border-top: 1px solid #e2e8f0; font-size: 0.75rem; color: #64748b; line-height: 1.5; text-align: justify;">
                <p style="margin: 0 0 12px 0; font-weight: bold; text-align: center; color: #475569;">
                    ⚠️ Questa è un'email generata automaticamente, si prega di non rispondere.
                </p>
                <p style="margin: 0 0 8px 0;">
                    <strong>Informativa Privacy</strong> - Ai sensi del Regolamento (UE) 2016/679 si precisa che le informazioni contenute in questo messaggio sono riservate e ad uso esclusivo del destinatario. Qualora il messaggio in parola Le fosse pervenuto per errore, La preghiamo di eliminarlo senza copiarlo e di non inoltrarlo a terzi, dandocene gentilmente comunicazione. Grazie.
                </p>
                <p style="margin: 0;">
                    <strong>Privacy Information</strong> - This message, for the Regulation (UE) 2016/679, may contain confidential and/or privileged information. If you are not the addressee or authorized to receive this for the addressee, you must not use, copy, disclose or take any action based on this message or any information herein. If you have received this message in error, please advise the sender immediately by reply e-mail and delete this message. Thank you for your cooperation.
                </p>
            </div>
        </div>
    </body></html>
    """

    body_text = f"{intro}\n\nTODO: {todo_title}\n{todo_content or ''}"

    return await send_email(to_addresses, subject, body_html, body_text)


async def send_calendar_reminder_email(
    to_addresses: List[str],
    event_title: str,
    event_description: Optional[str],
    event_start_date: datetime,
    creator_name: str,
) -> bool:
    """Invia la email di promemoria per un evento del calendario."""
    subject = f"HiPlan - Promemoria Evento: {event_title}"
    intro = f"Promemoria per l'evento creato da <strong>{creator_name}</strong>."

    content_html = f"<p style='white-space: pre-wrap; margin-top: 12px;'>{event_description}</p>" if event_description else ""
    date_html = f"<p style='margin-top: 12px; font-size: 0.9rem; color: #2563eb;'><strong>📅 Data e Ora:</strong> {event_start_date.strftime('%d/%m/%Y %H:%M')}</p>"

    body_html = f"""
    <html><body style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 40px 20px;">
        <div style="max-width: 650px; margin: auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #185FA5, #2563eb); padding: 24px 32px;">
                <h1 style="margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: 0.5px; color: #ffffff;">HiPlan</h1>
            </div>
            <div style="padding: 24px 32px 32px 32px;">
                <p style="font-size: 1.05rem; line-height: 1.6; margin-top: 0; margin-bottom: 8px;">{intro}</p>
                <div style="background: #f8fafc; border-left: 5px solid #2563eb; border-radius: 6px; padding: 24px; margin: 12px 0;">
                    <h2 style="margin: 0 0 12px 0; font-size: 1.3rem; color: #0f172a;">{event_title}</h2>
                    {content_html}
                    {date_html}
                </div>
                <p style="color: #64748b; font-size: 0.9rem; border-top: 1px solid #e2e8f0; padding-top: 24px;">Accedi a HiPlan per visualizzare il dettaglio nel tuo calendario.</p>
            </div>
            <div style="background-color: #f1f5f9; padding: 24px; border-top: 1px solid #e2e8f0; font-size: 0.75rem; color: #64748b; line-height: 1.5; text-align: justify;">
                <p style="margin: 0 0 12px 0; font-weight: bold; text-align: center; color: #475569;">
                    ⚠️ Questa è un'email generata automaticamente, si prega di non rispondere.
                </p>
            </div>
        </div>
    </body></html>
    """

    body_text = f"{intro}\n\nEvento: {event_title}\nData: {event_start_date.strftime('%d/%m/%Y %H:%M')}\n{event_description or ''}"

    return await send_email(to_addresses, subject, body_html, body_text)


async def send_richiesta_commerciale_email(
    to_addresses: List[str],
    richiesta_title: str,
    cliente: str,
    author_name: str,
    phase: str,  # "nuova_richiesta" | "manca_listino" | "completata"
) -> bool:
    """
    Invia le email di notifica per il workflow Richieste Commerciali.
    Phase:
    - nuova_richiesta → a Acquisti: è arrivata una nuova richiesta
    - manca_listino   → a Admin: serve il prezzo di listino
    - completata      → a Commerciale: la richiesta è completata
    """
    if phase == "nuova_richiesta":
        subject = f"HiPlan - Nuova Richiesta Commerciale: {richiesta_title}"
        badge_color = "#f59e0b"
        badge_text = "🟡 IN LAVORAZIONE"
        intro = f"È stata inserita una nuova richiesta commerciale da <strong>{author_name}</strong> già in lavorazione."
        cta = "Accedi a HiPlan per verificare la richiesta, compilare i costi degli articoli o aggiungerne di nuovi."
    elif phase == "manca_listino":
        subject = f"HiPlan - Richiesta in attesa di Listino: {richiesta_title}"
        badge_color = "#3b82f6"
        badge_text = "🔵 MANCA LISTINO"
        intro = f"L'ufficio acquisti ha compilato la richiesta <strong>{richiesta_title}</strong> per il cliente <strong>{cliente}</strong>. È necessario inserire il prezzo di listino."
        cta = "Accedi a HiPlan per inserire i prezzi di listino e completare la richiesta."
    else:  # completata
        subject = f"HiPlan - Richiesta Commerciale Completata: {richiesta_title}"
        badge_color = "#22c55e"
        badge_text = "🟢 COMPLETATA"
        intro = f"La richiesta commerciale <strong>{richiesta_title}</strong> per il cliente <strong>{cliente}</strong> è stata completata con i prezzi di listino."
        cta = "Accedi a HiPlan per visualizzare il dettaglio completo della richiesta."

    body_html = f"""
    <html><body style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 40px 20px;">
        <div style="max-width: 650px; margin: auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
            <div style="background: linear-gradient(135deg, #185FA5, #2563eb); padding: 24px 32px;">
                <h1 style="margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: 0.5px; color: #ffffff;">HiPlan</h1>
                <p style="margin: 6px 0 0 0; color: #bfdbfe; font-size: 0.9rem;">Richieste Commerciali</p>
            </div>
            <div style="padding: 24px 32px 32px 32px;">
                <div style="display: inline-block; background-color: {badge_color}; color: #fff; padding: 4px 14px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; margin-bottom: 16px;">
                    {badge_text}
                </div>
                <p style="font-size: 1.05rem; line-height: 1.6; margin-top: 0; margin-bottom: 8px;">{intro}</p>
                <div style="background: #f8fafc; border-left: 5px solid {badge_color}; border-radius: 6px; padding: 20px; margin: 12px 0;">
                    <p style="margin: 0 0 8px 0; font-size: 0.9rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Richiesta</p>
                    <h2 style="margin: 0 0 8px 0; font-size: 1.2rem; color: #0f172a;">{richiesta_title}</h2>
                    <p style="margin: 0; font-size: 0.95rem; color: #475569;"><strong>Cliente:</strong> {cliente}</p>
                </div>
                <p style="color: #64748b; font-size: 0.9rem; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-bottom: 0;">{cta}</p>
            </div>
            <div style="background-color: #f1f5f9; padding: 20px 32px; border-top: 1px solid #e2e8f0; font-size: 0.75rem; color: #64748b; line-height: 1.5; text-align: justify;">
                <p style="margin: 0 0 8px 0; font-weight: bold; text-align: center; color: #475569;">
                    ⚠️ Questa è un'email generata automaticamente, si prega di non rispondere.
                </p>
                <p style="margin: 0;">
                    <strong>Informativa Privacy</strong> - Ai sensi del Regolamento (UE) 2016/679 si precisa che le informazioni contenute in questo messaggio sono riservate e ad uso esclusivo del destinatario. Qualora il messaggio in parola Le fosse pervenuto per errore, La preghiamo di eliminarlo senza copiarlo e di non inoltrarlo a terzi, dandocene gentilmente comunicazione. Grazie.
                </p>
            </div>
        </div>
    </body></html>
    """

    body_text = f"{intro}\n\nRichiesta: {richiesta_title}\nCliente: {cliente}\n\n{cta}"
    return await send_email(to_addresses, subject, body_html, body_text)

