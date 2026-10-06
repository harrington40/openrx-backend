import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import nestClient from '../api/nest-client';
import BookAppointmentPage from '../features/booking/BookAppointmentPage';
import VideoConsultPage from '../features/telehealth/VideoConsultPage';

// The booking page talks straight to the NestJS backend; stub the axios wrapper
// so no request leaves the test.
vi.mock('../api/nest-client', () => ({
  default: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), put: vi.fn() },
}));

// Signalling must never actually dial out from a unit test.
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })),
}));

const post = nestClient.post as unknown as ReturnType<typeof vi.fn>;
const get = nestClient.get as unknown as ReturnType<typeof vi.fn>;

// jsdom does not implement scrollTo/scrollIntoView; the page calls both.
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
Element.prototype.scrollIntoView = vi.fn();

/** Fill the required fields and submit the booking form. */
function submitBooking() {
  const form = document.querySelector('form') as HTMLFormElement;
  const inputs = form.querySelectorAll('input');
  fireEvent.change(inputs[0], { target: { value: 'Ada' } }); // first name
  fireEvent.change(inputs[1], { target: { value: 'Lovelace' } }); // last name
  fireEvent.change(inputs[2], { target: { value: '0770000000' } }); // phone
  fireEvent.change(inputs[4], { target: { value: '2026-05-01' } }); // preferred date
  fireEvent.submit(form);
}

describe('BookAppointmentPage — consultation type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({
      data: { id: 12, status: 'pending', consultation_type: 'video', video_room: 'vc-abc12345' },
    });
  });

  const renderPage = (settings: Record<string, boolean | string> = { video_consultation_enabled: true }) => {
    get.mockResolvedValue({ data: settings });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <BookAppointmentPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('offers an in-person / video choice and defaults to in person', async () => {
    renderPage();
    // The option only appears once the public feature flag has been read.
    expect(await screen.findByText('Consultation type')).toBeInTheDocument();
    const inPerson = screen.getByRole('button', { name: /In person/ });
    const video = screen.getByRole('button', { name: /Video call/ });
    expect(inPerson).toHaveAttribute('aria-pressed', 'true');
    expect(video).toHaveAttribute('aria-pressed', 'false');
    // The video option is deliberately promoted: interactive card + "Popular" flag.
    expect(video).toHaveClass('vc-option');
    expect(screen.getByText('Popular')).toBeInTheDocument();
  });

  it('promotes video from the hero callout and preselects it', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Start a video visit/i }));
    const video = screen.getByRole('button', { name: /Video call/ });
    expect(video).toHaveAttribute('aria-pressed', 'true');
    expect(video).toHaveClass('vc-option-video-active');
    expect(screen.getByText('Selected')).toBeInTheDocument();
  });

  it('submits an in-person booking by default', async () => {
    renderPage();
    await screen.findByText('Consultation type');
    submitBooking();

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/booking/request');
    expect(body).toMatchObject({ consultation_type: 'in_person', source: 'whatsapp' });
  });

  it('submits a video booking and hands back the room invite link', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Video call/ }));
    // Choosing video surfaces the "we will send you a link" hint before submit.
    expect(screen.getByText(/private video link/i)).toBeInTheDocument();

    submitBooking();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ consultation_type: 'video' });

    expect(await screen.findByText(/Video consultation requested/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/\/video\/vc-abc12345$/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Join video room now/i })).toHaveAttribute(
      'href',
      '/video/vc-abc12345',
    );
  });

  it('hides every video affordance when an admin turns video consultations off', async () => {
    renderPage({ video_consultation_enabled: false });

    expect(await screen.findByText('Book an Appointment')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/settings/public'));

    expect(screen.queryByText('Consultation type')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Video call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start a video visit/i })).not.toBeInTheDocument();

    // And a submission falls back to an in-person request.
    submitBooking();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ consultation_type: 'in_person' });
  });
});

describe('VideoConsultPage — public telehealth room', () => {
  it('names the room, the joining role and the invite URL', () => {
    render(
      <MemoryRouter initialEntries={['/video/vc-test123?role=physician']}>
        <Routes>
          <Route path="/video/:room" element={<VideoConsultPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Room vc-test123/)).toBeInTheDocument();
    expect(screen.getByText(/joined as physician/)).toBeInTheDocument();
    // jsdom exposes no camera, so the page must fail gracefully rather than crash.
    expect(screen.getByText(/Could not access your camera\/microphone/i)).toBeInTheDocument();
    expect(screen.getAllByText(/\/video\/vc-test123/).length).toBeGreaterThan(0);
  });
});
