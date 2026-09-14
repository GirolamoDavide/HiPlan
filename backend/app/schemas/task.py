# pyrefly: ignore [missing-import]
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, List
from datetime import date
from app.models.task import TaskType, TaskPriority
from app.models.link import LinkType


# --- Task Schemas ---

class TaskCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    start_date: date
    end_date: Optional[date] = None
    duration: int = Field(default=1, ge=0)
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    type: TaskType = TaskType.TASK
    priority: TaskPriority = TaskPriority.MEDIUM
    parent_id: Optional[str] = None
    assigned_to: Optional[str] = None
    sort_order: int = 0
    open: int = 1
    planned_hours: float = 8.0
    workers: List[str] = []
    worker_hours: dict = {}
    actual_hours: dict = {}
    color: Optional[str] = None
    department: Optional[str] = None
    budget_mode: Optional[str] = None
    completed: int = 0
    has_vacation_conflict: int = 0
    excluded_dates: List[str] = []
    custom_dates: Optional[List[dict]] = []


class TaskUpdate(BaseModel):
    text: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    duration: Optional[int] = None
    progress: Optional[float] = None
    type: Optional[TaskType] = None
    priority: Optional[TaskPriority] = None
    parent_id: Optional[str] = None
    assigned_to: Optional[str] = None
    sort_order: Optional[int] = None
    open: Optional[int] = None
    planned_hours: Optional[float] = None
    workers: Optional[List[str]] = None
    worker_hours: Optional[dict] = None
    actual_hours: Optional[dict] = None
    color: Optional[str] = None
    department: Optional[str] = None
    budget_mode: Optional[str] = None
    completed: Optional[int] = None
    has_vacation_conflict: Optional[int] = None
    excluded_dates: Optional[List[str]] = None
    custom_dates: Optional[List[dict]] = None


class TaskOut(BaseModel):
    """Formato compatibile DHTMLX Gantt + Ufficio Tecnico."""
    id: str
    text: str
    start_date: str  # DHTMLX vuole stringhe "YYYY-MM-DD HH:MM"
    end_date: Optional[str] = None
    duration: int
    progress: float
    type: str
    priority: str
    parent: str  # "0" = root
    assigned_to: Optional[str] = None
    sort_order: int
    open: int
    planned_hours: float = 8.0
    workers: List[str] = []
    worker_hours: dict = {}
    actual_hours: dict = {}
    color: Optional[str] = None
    department: Optional[str] = None
    budget_mode: Optional[str] = None
    completed: int = 0
    has_vacation_conflict: int = 0
    excluded_dates: List[str] = []
    custom_dates: Optional[List[dict]] = []

    model_config = ConfigDict(from_attributes=True)


# --- Link Schemas ---

class LinkCreate(BaseModel):
    source: str
    target: str
    type: str = "0"  # Default FS
    lag: int = 0


class LinkUpdate(BaseModel):
    source: Optional[str] = None
    target: Optional[str] = None
    type: Optional[str] = None
    lag: Optional[int] = None


class LinkOut(BaseModel):
    id: str
    source: str
    target: str
    type: str
    lag: int

    model_config = ConfigDict(from_attributes=True)


# Risposta Gantt completa (task + links in un unico payload)
class GanttData(BaseModel):
    tasks: List[TaskOut] = []
    links: List[LinkOut] = []


class LogHoursRequest(BaseModel):
    date: str
    hours: float
