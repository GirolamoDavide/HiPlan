from app.models.base import Base, engine, AsyncSessionLocal
from app.models.user import User, UserRole
from app.models.project import Project, ProjectMember, ProjectStatus, MemberRole
from app.models.task import Task, TaskType, TaskPriority
from app.models.link import Link, LinkType
from app.models.notification import Notification, NotificationType
from app.models.note import Note
from app.models.task_collaboration import TaskComment, TaskChecklistItem
from app.models.vacation import Vacation
from app.models.phase_template import PhaseTemplate
from app.models.setting import Setting
from app.models.ticket import Ticket, TicketReply, TicketStatus, TicketPriority
from app.models.activity_log import ActivityLog, ActivityCategory
from app.models.todo import Todo
from app.models.email_log import EmailLog
from app.models.replan_log import ReplanLog, ReplanActionType
from app.models.calendar_event import CalendarEvent
from app.models.richiesta_commerciale import RichiestaCommerciale, ArticoloRichiesta, RichiestaStatus, TipoFornitura
from app.models.automation import AutomationRule, AutomationLog, AutomationTriggerType, AutomationActionType

__all__ = [
    "Base", "engine", "AsyncSessionLocal",
    "User", "UserRole",
    "Project", "ProjectMember", "ProjectStatus", "MemberRole",
    "Task", "TaskType", "TaskPriority",
    "Link", "LinkType",
    "Notification", "NotificationType",
    "Note",
    "TaskComment", "TaskChecklistItem",
    "EmailLog",
    "Vacation", "PhaseTemplate",
    "Setting",
    "Ticket", "TicketReply", "TicketStatus", "TicketPriority",
    "ActivityLog", "ActivityCategory",
    "Todo",
    "ReplanLog", "ReplanActionType",
    "CalendarEvent",
    "RichiestaCommerciale", "ArticoloRichiesta", "RichiestaStatus", "TipoFornitura",
    "AutomationRule", "AutomationLog", "AutomationTriggerType", "AutomationActionType",
]
