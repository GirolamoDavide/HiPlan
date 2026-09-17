import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import AppIcon from '../../src/components/ui/AppIcon';

describe('AppIcon Component', () => {
  it('renders correctly with default props', () => {
    const { container } = render(<AppIcon name="home" />);
    // Should render an SVG with the provided name
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    
    // Check default dimensions
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.getAttribute('height')).toBe('18');
  });

  it('applies custom size and strokeWidth', () => {
    const { container } = render(<AppIcon name="user" size={24} strokeWidth={2.5} />);
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
    expect(svg.getAttribute('stroke-width')).toBe('2.5');
  });

  it('applies custom className', () => {
    const { container } = render(<AppIcon name="settings" className="custom-class" />);
    const svg = container.querySelector('svg');
    expect(svg.classList.contains('custom-class')).toBe(true);
  });

  it('renders all icons required for automations without fallback', () => {
    const requiredIcons = [
      'target', 'trendingUp', 'package', 'tool', 'eye', 'globe', 'activity',
      'creditCard', 'zap', 'tag', 'calendar', 'bell', 'todo', 'sparkles',
      'checkCircle', 'clock', 'alertTriangle', 'play', 'filter', 'edit', 'trash'
    ];

    for (const iconName of requiredIcons) {
      const { container } = render(<AppIcon name={iconName} />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg.children.length).toBeGreaterThan(0);
    }
  });
});
