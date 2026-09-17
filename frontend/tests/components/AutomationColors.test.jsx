import { describe, it, expect } from 'vitest';
import { TRIGGER_DEFAULT_COLORS, CALENDAR_COLORS } from '../../src/pages/AutomationsPage';

describe('Automations Calendar Color Palette and Trigger Mapping', () => {
  it('defines all required colors in CALENDAR_COLORS', () => {
    expect(CALENDAR_COLORS.length).toBeGreaterThanOrEqual(5);
    const colorValues = CALENDAR_COLORS.map(c => c.value);
    expect(colorValues).toContain('#10b981'); // Verde Smeraldo
    expect(colorValues).toContain('#0284c7'); // Azzurro HiPlan
    expect(colorValues).toContain('#8b5cf6'); // Viola Indaco
    expect(colorValues).toContain('#f59e0b'); // Ambra
    expect(colorValues).toContain('#ef4444'); // Rosso Corallo
  });

  it('maps each trigger condition to its appropriate default color', () => {
    expect(TRIGGER_DEFAULT_COLORS.phase_completed).toBe('#10b981'); // Verde Smeraldo (Collaudo / Fine fase)
    expect(TRIGGER_DEFAULT_COLORS.phase_started).toBe('#0284c7');   // Azzurro (Inizio lavori)
    expect(TRIGGER_DEFAULT_COLORS.phase_progress_reached).toBe('#8b5cf6'); // Viola Indaco (SAL / Avanzamento)
    expect(TRIGGER_DEFAULT_COLORS.budget_hours_exceeded).toBe('#f59e0b');  // Ambra (Attenzione budget)
    expect(TRIGGER_DEFAULT_COLORS.phase_delayed).toBe('#ef4444');          // Rosso Corallo (Urgente / Ritardo)
    expect(TRIGGER_DEFAULT_COLORS.phase_deadline_approaching).toBe('#f59e0b'); // Ambra (Scadenza imminente)
  });
});

import { getSmartContentDefaults } from '../../src/pages/AutomationsPage';

describe('Smart Content Defaults based on Quando/Se/Allora', () => {
  it('prefills technical office completion with materials order', () => {
    const defaults = getSmartContentDefaults('phase_completed', 'ufficio_tecnico', 'create_todo');
    expect(defaults.todo_title).toContain('{project_code}');
    expect(defaults.todo_content).toContain('{task_name}');
    expect(defaults.assignee_department).toBe('acquisti');
    expect(defaults.event_title).toContain('Revisione Tecnica');
  });

  it('prefills delayed phase with urgent recovery task and calendar meeting', () => {
    const defaults = getSmartContentDefaults('phase_delayed', '', 'create_todo');
    expect(defaults.todo_title).toContain('🚨');
    expect(defaults.todo_content).toContain('{end_date}');
    expect(defaults.assignee_department).toBe('pm');
    expect(defaults.event_title).toContain('Riunione Straordinaria Ritardo');
  });

  it('prefills budget hours exceeded with budget analysis task', () => {
    const defaults = getSmartContentDefaults('budget_hours_exceeded', 'produzione', 'create_calendar_event');
    expect(defaults.event_title).toContain('Audit Costi');
    expect(defaults.todo_title).toContain('⚠️ Analisi scostamento ore');
    expect(defaults.assignee_department).toBe('pm');
  });

  it('prefills production start with kit verification', () => {
    const defaults = getSmartContentDefaults('phase_started', 'produzione', 'create_todo');
    expect(defaults.todo_title).toContain('kit materiali');
    expect(defaults.assignee_department).toBe('produzione');
    expect(defaults.event_title).toContain('Kick-off Avvio Produzione');
  });
});

