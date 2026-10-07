import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';

describe('App', () => {
  it('renders login page when not authenticated', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );

    // The brand + tagline appear twice (desktop marketing panel and the mobile
    // card), so assert at least one of each rather than a single exact match.
    expect(screen.getAllByText('OpenRx Health').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Electronic Prescription & Health Records').length,
    ).toBeGreaterThan(0);
  });

  it('shows sign in button on login page', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('button', { name: /sign in/i }),
    ).toBeInTheDocument();
  });
});
