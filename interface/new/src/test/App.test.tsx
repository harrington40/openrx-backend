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

    expect(screen.getByText('OpenRx')).toBeInTheDocument();
    expect(screen.getByText('Electronic Prescription & Health Records')).toBeInTheDocument();
  });

  it('shows sign in button on login page', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('Sign In with OpenRx')).toBeInTheDocument();
  });
});
