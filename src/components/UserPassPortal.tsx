import React, { useState, useEffect } from 'react';
import { AttendeeCategory, DigitalPassData, PaymentStatus, EventSettings } from '../types';
import { MasterTicketCanvas } from './MasterTicketCanvas';

interface UserPassPortalProps {
  initialAccessToken?: string;
}

export const UserPassPortal: React.FC<UserPassPortalProps> = ({ initialAccessToken }) => {
  // Pass State
  const [ticketData, setTicketData] = useState<DigitalPassData>({
    ticketId: '',
    fullName: '',
    category: 'FRESHER',
    college: '',
    paymentStatus: 'PENDING',
    entryPassStatus: 'NOT_CREATED',
    checkInStatus: 'NOT_CHECKED_IN',
    eventDate: '02 OCT 2026',
    doorsOpen: '5:30 PM Sharp',
    venue: 'Pune (MSAP Campus Main Auditorium)',
    eventName: "53rd Freshers' Meet 2026",
    organization: "Manipur Students' Association Pune (MSAP)",
    amount: '₹350',
    qrToken: '',
    paymentUtr: '',
  });

  const [eventSettings, setEventSettings] = useState<EventSettings>({
    time: '5:30 PM Sharp',
    venue: 'Pune (MSAP Campus Main Auditorium)',
    registrationPrice: 350,
    updatedAt: '',
  });

  const [hashStamp, setHashStamp] = useState('SHA256: 8F7C•••E29A');
  const [isCopied, setIsCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [walletAdded, setWalletAdded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  // Form State
  const [inputName, setInputName] = useState('');
  const [inputPhone, setInputPhone] = useState('');
  const [inputEmail, setInputEmail] = useState('');
  const [inputRoll, setInputRoll] = useState('');
  const [inputDept, setInputDept] = useState('');
  const [inputCourseClass, setInputCourseClass] = useState('');
  const [inputAcademicYear, setInputAcademicYear] = useState('');
  const [selectedCohort, setSelectedCohort] = useState<AttendeeCategory>('FRESHER');
  const [inputUtr, setInputUtr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formSuccessMessage, setFormSuccessMessage] = useState<string | null>(null);
  const [formErrorMessage, setFormErrorMessage] = useState<string | null>(null);
  const [showGoogleFormModal, setShowGoogleFormModal] = useState(false);

  // UPI Payment Flow State
  const [showPaymentPanel, setShowPaymentPanel] = useState(false);
  const [utrInput, setUtrInput] = useState('');
  const [utrSubmitting, setUtrSubmitting] = useState(false);
  const [utrMessage, setUtrMessage] = useState<string | null>(null);

  const [activeAccessToken, setActiveAccessToken] = useState<string | null>(initialAccessToken || null);
  const [paymentLoading, setPaymentLoading] = useState(false);

  const loadEventSettings = async () => {
    try {
      const res = await fetch('/api/event-settings');
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings) {
        const settings: EventSettings = data.settings;
        setEventSettings(settings);
        setTicketData((prev) => ({
          ...prev,
          doorsOpen: settings.time,
          venue: settings.venue,
          amount: `₹${settings.registrationPrice}`,
        }));
      }
    } catch (err) {
      console.warn('Event settings could not be loaded; using current local display values.', err);
    }
  };

  useEffect(() => {
    loadEventSettings();
  }, []);

  // Load pass if initialAccessToken is provided
  useEffect(() => {
    if (initialAccessToken) {
      setActiveAccessToken(initialAccessToken);
      loadPassByToken(initialAccessToken);
    }
  }, [initialAccessToken]);

  // Payment Status Polling
  // While pass is not yet PAID and activeAccessToken exists, poll every 5 seconds
  useEffect(() => {
    if (!activeAccessToken || ticketData.paymentStatus === 'PAID') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/payments/status-by-token/${encodeURIComponent(activeAccessToken)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.isPaid || data.paymentStatus === 'PAID') {
            await loadPassByToken(activeAccessToken);
          }
        }
      } catch (e) {
        // Silently retry on next tick
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [activeAccessToken, ticketData.paymentStatus]);

  const loadRazorpayScript = (): Promise<boolean> => {
    return new Promise((resolve) => {
      if ((window as any).Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  // Show UPI Payment Panel (replaces Razorpay flow)
  const handleShowPaymentPanel = () => {
    setShowPaymentPanel(true);
    setUtrMessage(null);
    setUtrInput('');
  };

  // Submit UTR to backend
  const handleSubmitUtr = async () => {
    if (!activeAccessToken) {
      setUtrMessage('❌ Session expired. Please search for your registration first.');
      return;
    }
    if (!utrInput.trim() || utrInput.trim().length < 5) {
      setUtrMessage('❌ Please enter a valid UTR / transaction reference (at least 5 characters).');
      return;
    }

    setUtrSubmitting(true);
    setUtrMessage(null);

    try {
      const res = await fetch('/api/payments/submit-utr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: activeAccessToken,
          paymentUtr: utrInput.trim(),
        }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        setUtrMessage('✅ Payment reference submitted! Our team will verify your payment and issue your ticket within a few hours.');
        // Update ticket data to show PAYMENT_SUBMITTED state
        setTicketData((prev) => ({
          ...prev,
          paymentStatus: 'PAYMENT_SUBMITTED' as any,
          paymentUtr: utrInput.trim(),
        }));
      } else {
        setUtrMessage(`❌ ${data.error || 'Submission failed. Please try again.'}`);
      }
    } catch {
      setUtrMessage('❌ Network error. Please check your connection and try again.');
    } finally {
      setUtrSubmitting(false);
    }
  };

  // Canvas-based download: composite master ticket template with QR + ticket no + category
  const handleDownloadTicket = async () => {
    if (!ticketData.qrSvg && !ticketData.qrToken) {
      alert('Ticket QR code not available. Please ensure your payment is verified.');
      return;
    }

    setDownloading(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 443;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');

      // 1. Draw master ticket template as background
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, 0, 0, 1024, 443);
          resolve();
        };
        img.onerror = reject;
        img.src = '/master-ticket-template.jpg';
      });

      // 2. Generate QR code as image from SVG or token
      if (ticketData.qrSvg) {
        await new Promise<void>((resolve) => {
          const svgBlob = new Blob([ticketData.qrSvg!], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(svgBlob);
          const qrImg = new Image();
          qrImg.onload = () => {
            // QR code area on ticket stub: approx x=818, y=140, w=155, h=155
            ctx.drawImage(qrImg, 818, 140, 155, 155);
            URL.revokeObjectURL(url);
            resolve();
          };
          qrImg.onerror = () => { URL.revokeObjectURL(url); resolve(); };
          qrImg.src = url;
        });
      }

      // 3. Overlay Ticket Number — white text on the stub
      ctx.font = 'bold 14px Arial, sans-serif';
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'left';
      const ticketNoValue = ticketData.ticketId || 'FM26-???';
      // Find the "FM26-XXX" area on the ticket stub — approximately y=345
      ctx.fillText(ticketNoValue, 830, 318);

      // 4. Overlay Category
      ctx.font = 'bold 13px Arial, sans-serif';
      ctx.fillStyle = '#1a1a2e';
      const categoryValue = ticketData.category === 'SENIOR' ? 'SENIOR' : 'FRESHER';
      ctx.fillText(categoryValue, 830, 380);

      // 5. Download as PNG
      const link = document.createElement('a');
      link.download = `MSAP-FM26-Ticket-${ticketData.ticketId || 'pass'}.png`;
      link.href = canvas.toDataURL('image/png', 1.0);
      link.click();
    } catch (err) {
      console.error('Ticket download error:', err);
      // Fallback: print
      window.print();
    } finally {
      setDownloading(false);
    }
  };

  const loadPassByToken = async (token: string) => {
    setActiveAccessToken(token);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(token)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ticket) {
          setTicketData(data.ticket);
          setEventSettings((prev) => ({
            ...prev,
            time: data.ticket.doorsOpen || prev.time,
            venue: data.ticket.venue || prev.venue,
            registrationPrice: Number(String(data.ticket.amount || `₹${prev.registrationPrice}`).replace(/[^0-9.]/g, '')) || prev.registrationPrice,
          }));
          updateHashStamp();
        }
      }
    } catch (err) {
      console.error('Error loading pass:', err);
    }
  };

  const updateHashStamp = () => {
    const randomHex = Math.random().toString(16).substring(2, 6).toUpperCase() + '•••' + Math.random().toString(16).substring(2, 6).toUpperCase();
    setHashStamp(`SHA256: ${randomHex}`);
  };

  // Search / Retrieve Pass
  const handleSearchPass = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchMessage(null);

    try {
      const res = await fetch(`/api/tickets/lookup?q=${encodeURIComponent(searchQuery.trim())}`);
      const data = await res.json();

      if (res.ok && data.accessToken) {
        setSearchMessage(`✅ Pass found for ${data.fullName} (${data.ticketId})!`);
        await loadPassByToken(data.accessToken);

        // Smooth scroll to digital pass
        const el = document.getElementById('digitalTicketCard');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ring-4', 'ring-[#38BDF8]');
          setTimeout(() => el.classList.remove('ring-4', 'ring-[#38BDF8]'), 1500);
        }
      } else {
        setSearchMessage(`❌ ${data.error || 'No matching attendee found. Try another search.'}`);
      }
    } catch {
      setSearchMessage('❌ Network lookup failed. Please try again.');
    } finally {
      setSearchLoading(false);
    }
  };

  // Submit Registration Intake
  const handleSubmitRegistration = async () => {
    if (!inputName.trim() || !inputPhone.trim() || !inputEmail.trim()) {
      setFormErrorMessage('Please complete Name, Mobile, and Email fields.');
      return;
    }

    setSubmitting(true);
    setFormErrorMessage(null);
    setFormSuccessMessage(null);

    try {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: inputName.trim(),
          phone: inputPhone.trim(),
          email: inputEmail.trim(),
          college: inputDept,
          category: selectedCohort,
          rollId: inputRoll.trim(),
          courseClass: inputCourseClass.trim(),
          academicYear: inputAcademicYear.trim(),
          paymentUtr: inputUtr.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (res.ok && data.attendee) {
        const regDisplay = data.attendee.registration_id || 'REGISTERED';
        setFormSuccessMessage(`✅ Registration saved! Registration ID: ${regDisplay}. Complete payment below.`);
        setShowPaymentPanel(true);
        if (data.attendee.access_token) {
          await loadPassByToken(data.attendee.access_token);
        }

        // Pulse animation on pass card
        const card = document.getElementById('digitalTicketCard');
        if (card) {
          card.classList.add('ring-4', 'ring-[#34D399]', 'scale-[1.01]');
          setTimeout(() => card.classList.remove('ring-4', 'ring-[#34D399]', 'scale-[1.01]'), 1000);
        }
      } else {
        setFormErrorMessage(data.error || 'Registration failed.');
      }
    } catch {
      setFormErrorMessage('Unable to connect to registration server.');
    } finally {
      setSubmitting(false);
    }
  };

  // Copy Ticket ID
  const handleCopyTicket = () => {
    if (!ticketData.ticketId) return;
    navigator.clipboard.writeText(ticketData.ticketId).catch(() => {});
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Download Ticket Card
  const handleDownloadTicket = () => {
    setDownloading(true);
    setTimeout(() => {
      window.print();
      setDownloading(false);
    }, 600);
  };

  // Add to Wallet
  const handleAddToWallet = () => {
    setWalletAdded(true);
    setTimeout(() => setWalletAdded(false), 2500);
  };

  // Share via WhatsApp
  const handleShareWhatsApp = () => {
    const text = encodeURIComponent(
      `🎟️ My official pass for MSAP 53rd Freshers' Meet 2026 is confirmed!\n\n` +
      `Ticket ID: ${ticketData.ticketId}\n` +
      `Name: ${ticketData.fullName}\n` +
      `Date: 02 OCT 2026 | ${ticketData.venue}\nTime: ${ticketData.doorsOpen}\n\n` +
      `See you at the Gala!`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const isPaid = ticketData.paymentStatus === 'PAID';

  return (
    <div className="w-full min-h-screen bg-[#061A2E] text-[#EAF6FF] antialiased">
      {/* ================= HEADER (PUBLIC - NO ADMIN LINKS AS SPECIFIED) ================= */}
      <header className="fixed top-0 left-0 right-0 w-full z-50 bg-[#061A2E]/95 backdrop-blur-2xl border-b border-[#164468]/60 shadow-[0_4px_30px_rgba(6,26,46,0.6)]">
        <div className="h-20 max-w-7xl mx-auto px-5 lg:px-12 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#0284C7] to-[#38BDF8] flex items-center justify-center shadow-[0_0_16px_rgba(56,189,248,0.4)] text-[#061A2E] font-extrabold text-sm tracking-wider font-display-title">
              MSAP
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-headline-sm text-white tracking-tight font-display-title">MSAP</span>
                <span className="font-label-caps text-[#38BDF8] px-1.5 py-0.5 rounded bg-[#103A5F] font-mono-code font-bold">2026</span>
              </div>
              <span className="font-label-md text-[#9DB8CF] hidden sm:inline">53rd Freshers' Meet Gala</span>
            </div>
          </div>

          <div className="hidden xl:flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#0C2C4A] border border-[#34D399]/30 shadow-[0_0_12px_rgba(52,211,153,0.15)]">
              <span className="w-2 h-2 rounded-full bg-[#34D399] animate-pulse"></span>
              <span className="font-label-md text-[#EAF6FF]">Apps Script Live Sync Engine</span>
            </div>
            <div className="flex items-center gap-2 text-[#9DB8CF] font-label-md">
              <span className="material-symbols-outlined text-[#38BDF8] text-[16px]">calendar_today</span>
              <span>02 OCT 2026</span>
              <span className="text-[#164468]">•</span>
              <span className="material-symbols-outlined text-[#38BDF8] text-[16px]">location_on</span>
              <span className="max-w-[240px] truncate">{eventSettings.venue}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setShowGoogleFormModal(true)}
              className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#0C2C4A] hover:bg-[#103A5F] text-[#38BDF8] border border-[#164468] transition-colors text-xs font-semibold cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">assignment</span>
              <span>Google Form Link</span>
            </button>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0C2C4A] text-[#38BDF8] border border-[#164468] text-xs">
              <span className="material-symbols-outlined text-[16px]">verified_user</span>
              <span className="hidden sm:inline">Official Ticketing</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-[#38BDF8] flex items-center justify-center shadow-[0_0_12px_rgba(56,189,248,0.4)] text-[#061A2E] font-bold text-xs">
              M26
            </div>
          </div>
        </div>
      </header>

      {/* ================= MAIN CONTENT ================= */}
      <main className="w-full pt-24 pb-16 min-h-[calc(100vh-140px)]">
        <div className="relative w-full overflow-hidden">
          {/* Ambient Glows */}
          <div className="absolute top-[-8rem] right-[-5rem] w-[42rem] h-[42rem] rounded-full bg-gradient-to-br from-[#0284C7]/20 via-[#38BDF8]/10 to-transparent blur-3xl pointer-events-none"></div>
          <div className="absolute top-[32rem] left-[-10rem] w-[36rem] h-[36rem] rounded-full bg-gradient-to-tr from-[#38BDF8]/15 via-[#0284C7]/10 to-transparent blur-3xl pointer-events-none"></div>
          <div className="absolute bottom-20 right-1/4 w-[30rem] h-[30rem] rounded-full bg-gradient-to-t from-[#FDBA74]/15 via-[#FDBA74]/5 to-transparent blur-3xl pointer-events-none"></div>

          <div className="max-w-7xl mx-auto px-5 lg:px-12 flex flex-col gap-10 relative z-10">
            {/* ================= 1. HERO HEADER ================= */}
            <section className="flex flex-col gap-4 items-start pt-4">
              <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30 shadow-[0_0_18px_rgba(253,186,116,0.25)]">
                <span className="material-symbols-outlined text-[16px] text-[#FDBA74]">stars</span>
                <span className="font-label-caps tracking-widest text-[#FDBA74] uppercase">53RD INDUCTION FESTIVAL • GENESIS GALA</span>
                <span className="w-1.5 h-1.5 rounded-full bg-[#FDBA74] animate-ping"></span>
              </div>

              <div className="flex flex-col gap-1">
                <h1 className="font-display-title font-display-hero tracking-tight bg-gradient-to-r from-[#EAF6FF] via-[#7DD3FC] to-[#38BDF8] bg-clip-text text-transparent">
                  MSAP 53rd Freshers' Meet 2026
                </h1>
                <p className="font-body-lg text-[#9DB8CF] max-w-3xl">
                  Annual Induction Festival & Gala Night organized by Manipur Students' Association Pune (MSAP). Complete the registration form and verify your payment to automatically issue your authentic cryptographically signed entry voucher pass.
                </p>
              </div>

              {/* Event Metadata Pills */}
              <div className="flex flex-wrap items-center gap-3 w-full pt-1">
                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#38BDF8] text-[20px]">calendar_month</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">EVENT DATE</span>
                    <span className="font-label-lg text-[#EAF6FF]">02 OCT 2026</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#7DD3FC] text-[20px]">schedule</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">DOORS OPEN</span>
                    <span className="font-label-lg text-[#EAF6FF]">{eventSettings.time}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#FDBA74] text-[20px]">location_on</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">VENUE</span>
                    <span className="font-label-lg text-[#EAF6FF]">{eventSettings.venue}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#34D399] text-[20px]">confirmation_number</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">PASS TYPE</span>
                    <span className="font-label-lg text-[#EAF6FF]">All-Access Gala & Food Pass (₹{eventSettings.registrationPrice})</span>
                  </div>
                </div>
              </div>
            </section>

            {/* ================= 2. MAIN REGISTRATION & TICKET GENERATOR FLOW ================= */}
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* LEFT COLUMN: REGISTRATION INTAKE & SIMULATOR (5 Cols) */}
              <div className="lg:col-span-5 flex flex-col gap-5">
                {/* Quick Pass Retrieval Bar */}
                <div className="bg-[#0C2C4A]/95 backdrop-blur-xl p-4 rounded-2xl border border-[#164468] shadow-lg flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[#38BDF8] text-[20px]">search</span>
                    <span className="font-label-caps text-[#38BDF8] uppercase tracking-wider">RETRIEVE EXISTING PASS</span>
                  </div>

                  <div className="flex items-center gap-2 mt-1">
                    <input
                      className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] placeholder:text-[#9DB8CF] border border-[#164468] outline-none focus:border-[#38BDF8] focus:ring-1 focus:ring-[#38BDF8] transition-all"
                      placeholder="Enter Mobile No, Roll, or Ticket ID"
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearchPass()}
                    />
                    <button
                      onClick={handleSearchPass}
                      disabled={searchLoading}
                      className="px-4 py-2.5 rounded-xl bg-[#38BDF8] hover:bg-[#7DD3FC] text-[#061A2E] font-label-lg whitespace-nowrap shadow-sm transition-all flex items-center gap-1.5 shrink-0 cursor-pointer font-bold disabled:opacity-50"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {searchLoading ? 'progress_activity' : 'sync'}
                      </span>
                      <span>{searchLoading ? 'Searching...' : 'Search'}</span>
                    </button>
                  </div>

                  {searchMessage && (
                    <div className="text-xs p-2 rounded-lg bg-[#061A2E] border border-[#164468] text-[#EAF6FF] font-mono-code">
                      {searchMessage}
                    </div>
                  )}

                  <span className="font-label-md text-[#9DB8CF]">
                    Searches linked Google Sheet rows & MySQL database by Roll, Phone, or Ticket ID.
                  </span>
                </div>

                {/* Interactive Google Form / Registration Intake Form Card */}
                <div className="bg-[#0C2C4A]/95 backdrop-blur-2xl p-6 rounded-2xl border border-[#164468] shadow-xl flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#164468]/60 pb-3">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-[#103A5F] text-[#38BDF8] font-label-caps font-bold">
                          AUTOMATED INTAKE
                        </span>
                        <h2 className="font-headline-md text-white font-display-title">Student Registration</h2>
                      </div>
                      <p className="font-body-sm text-[#9DB8CF]">Synced with Google Forms & Apps Script Webhook</p>
                    </div>

                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#34D399]/15 border border-[#34D399]/30">
                      <span className="w-2 h-2 rounded-full bg-[#34D399]"></span>
                      <span className="font-label-caps text-[#34D399] font-semibold">ONLINE</span>
                    </div>
                  </div>

                  <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); handleSubmitRegistration(); }}>
                    {/* Full Candidate Name */}
                    <div className="flex flex-col gap-1">
                      <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between">
                        <span>FULL CANDIDATE NAME</span>
                        <span className="text-[#FB7185]">*</span>
                      </label>
                      <div className="relative">
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-md text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all"
                          placeholder="e.g. Aarav Sharma"
                          type="text"
                          value={inputName}
                          onChange={(e) => setInputName(e.target.value)}
                          required
                        />
                        <span className="material-symbols-outlined absolute right-3 top-2.5 text-[#9DB8CF] text-[20px]">
                          person
                        </span>
                      </div>
                    </div>

                    {/* Phone & Email */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between">
                          <span>WHATSAPP / MOBILE</span>
                          <span className="text-[#FB7185]">*</span>
                        </label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all"
                          placeholder="+91 98765 43210"
                          type="tel"
                          value={inputPhone}
                          onChange={(e) => setInputPhone(e.target.value)}
                          required
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between">
                          <span>LEARNER OFFICIAL EMAIL</span>
                          <span className="text-[#FB7185]">*</span>
                        </label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all"
                          placeholder="you@college.edu.in"
                          type="email"
                          value={inputEmail}
                          onChange={(e) => setInputEmail(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    {/* Roll ID & Department */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between">
                          <span>STUDENT / ROLL ID</span>
                          <span className="text-[#FB7185]">*</span>
                        </label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all"
                          type="text"
                          value={inputRoll}
                          onChange={(e) => setInputRoll(e.target.value)}
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF]">COLLEGE / DEPARTMENT</label>
                        <div className="relative">
                          <select
                            className="w-full bg-[#061A2E] px-3 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] appearance-none transition-all cursor-pointer"
                            value={inputDept}
                            onChange={(e) => setInputDept(e.target.value)}
                          >
                            <option value="" disabled>Select department</option>
                            <option value="B.Arch - Architecture">B.Arch - Architecture</option>
                            <option value="B.Des - Interior Design">B.Des - Interior Design</option>
                            <option value="B.Des - Fashion Design">B.Des - Fashion Design</option>
                            <option value="M.Plan - Urban Planning">M.Plan - Urban Planning</option>
                            <option value="Other University Affiliate">Other University Affiliate</option>
                          </select>
                          <span className="material-symbols-outlined absolute right-3 top-2.5 text-[#9DB8CF] text-[20px] pointer-events-none">
                            expand_more
                          </span>
                        </div>
                    </div>

                    {/* Course / Class & Academic Year */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF]">COURSE / CLASS</label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all"
                          placeholder="e.g. 1st Year B.Arch"
                          type="text"
                          value={inputCourseClass}
                          onChange={(e) => setInputCourseClass(e.target.value)}
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF]">ACADEMIC YEAR</label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all"
                          placeholder="e.g. 2026-2027"
                          type="text"
                          value={inputAcademicYear}
                          onChange={(e) => setInputAcademicYear(e.target.value)}
                        />
                      </div>
                    </div>

                    {/* CATEGORY TOGGLE: FRESHER vs SENIOR */}
                    <div className="flex flex-col gap-1.5 pt-1">
                      <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between">
                        <span>PARTICIPANT CATEGORY</span>
                        <span className="text-[#38BDF8] font-mono-code text-xs">REQUIRED FOR WRISTBAND</span>
                      </label>
                      <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[#061A2E] border border-[#164468]">
                        <button
                          type="button"
                          onClick={() => setSelectedCohort('FRESHER')}
                          className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg font-label-lg transition-all font-semibold cursor-pointer ${
                            selectedCohort === 'FRESHER'
                              ? 'bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] shadow-md'
                              : 'bg-transparent text-[#9DB8CF] hover:text-[#EAF6FF] hover:bg-[#103A5F]'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[18px]">verified</span>
                          <span>FRESHER (2026)</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedCohort('SENIOR')}
                          className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg font-label-lg transition-all font-semibold cursor-pointer ${
                            selectedCohort === 'SENIOR'
                              ? 'bg-gradient-to-r from-[#38BDF8] to-[#7DD3FC] text-[#061A2E] shadow-md'
                              : 'bg-transparent text-[#9DB8CF] hover:text-[#EAF6FF] hover:bg-[#103A5F]'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[18px]">school</span>
                          <span>SENIOR HOST</span>
                        </button>
                      </div>
                    </div>

                    {/* Payment Verification Section */}
                    <div className="p-4 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-3 mt-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-[#38BDF8] text-[22px]">receipt_long</span>
                          <span className="font-headline-sm text-white">Gala Pass: ₹{eventSettings.registrationPrice}</span>
                        </div>
                        <span className="px-2.5 py-0.5 rounded-full bg-[#34D399]/15 text-[#34D399] font-label-caps font-bold border border-[#34D399]/30 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]"></span>
                          MANUAL UPI AUDIT
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center text-xs">
                        <div className="p-2 rounded-lg bg-[#0C2C4A] flex flex-col">
                          <span className="font-label-caps text-[#9DB8CF]">OFFICIAL COUNCIL VPA</span>
                          <span className="font-mono-code text-[#38BDF8] font-bold text-[12px] truncate">
                            msap.freshers26@icici
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="font-label-caps text-[#9DB8CF]">BANK UTR / TXN NUMBER</span>
                          <input
                            className="w-full bg-[#0C2C4A] px-2.5 py-1.5 rounded-lg font-mono-code text-xs text-[#EAF6FF] border border-[#164468] outline-none"
                            type="text"
                            value={inputUtr}
                            onChange={(e) => setInputUtr(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    {formSuccessMessage && (
                      <div className="p-3 rounded-xl bg-[#34D399]/15 border border-[#34D399]/40 text-[#34D399] text-xs font-semibold">
                        {formSuccessMessage}
                      </div>
                    )}

                    {formErrorMessage && (
                      <div className="p-3 rounded-xl bg-[#FB7185]/15 border border-[#FB7185]/40 text-[#FB7185] text-xs font-semibold">
                        {formErrorMessage}
                      </div>
                    )}

                    {/* Submit Button */}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full mt-2 flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-gradient-to-r from-[#0284C7] via-[#38BDF8] to-[#7DD3FC] text-[#061A2E] font-headline-sm text-[16px] shadow-[0_0_24px_rgba(56,189,248,0.35)] hover:shadow-[0_0_32px_rgba(56,189,248,0.55)] hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer font-bold disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[22px]">
                        {submitting ? 'progress_activity' : 'auto_awesome'}
                      </span>
                      <span>{submitting ? 'Connecting MySQL...' : 'Register & Generate Ticket Pass'}</span>
                    </button>

                    <div className="flex items-center justify-between text-[#9DB8CF] text-xs pt-1">
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-[15px] text-[#34D399]">lock</span>
                        Direct MySQL + Google Sheets Sync
                      </span>
                      <span className="text-[#38BDF8] font-mono-code">Apps Script Engine: Active</span>
                    </div>
                  </form>
                </div>
              </div>

              {/* RIGHT COLUMN: MASTER TICKET & UPI PAYMENT LIFECYCLE (7 Cols) */}
              <div className="lg:col-span-7 flex flex-col gap-4 sticky top-24">
                {/* ---------------------------------------------------- */}
                {/* STATE 1: PAYMENT COMPLETED & VERIFIED -> EXACT MASTER TICKET */}
                {/* ---------------------------------------------------- */}
                {isPaid ? (
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[#34D399] text-[22px]">verified</span>
                        <span className="font-label-caps text-[#34D399] tracking-widest uppercase font-bold">
                          OFFICIAL MASTER ENTRY TICKET
                        </span>
                      </div>

                      <div className="px-3 py-1 rounded-full bg-[#34D399]/15 text-[#34D399] border border-[#34D399]/40 font-mono-code font-bold text-xs flex items-center gap-1.5 shadow-[0_0_12px_rgba(52,211,153,0.25)]">
                        <span className="w-2 h-2 rounded-full bg-[#34D399] animate-ping"></span>
                        <span>{ticketData.checkInStatus === 'CHECKED_IN' ? 'TICKET USED (CHECKED IN)' : 'PASS ACTIVE FOR ENTRY'}</span>
                      </div>
                    </div>

                    {/* Master Ticket Canvas Container */}
                    <div id="digitalTicketCard" className="w-full">
                      <MasterTicketCanvas
                        ticketId={ticketData.ticketId || 'FM26-001'}
                        category={ticketData.category}
                        qrToken={ticketData.qrToken}
                        qrDataUrl={ticketData.qrDataUrl}
                        qrSvg={ticketData.qrSvg}
                        fullName={ticketData.fullName}
                      />
                    </div>

                    {/* Verified Attendee Metadata Strip */}
                    <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">ATTENDEE</span>
                        <span className="font-bold text-white text-sm truncate">{ticketData.fullName}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">REGISTRATION ID</span>
                        <span className="font-mono-code font-bold text-[#38BDF8] text-sm">{ticketData.registrationId || 'REG-????'}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">TICKET NUMBER</span>
                        <span className="font-mono-code font-bold text-[#34D399] text-sm">{ticketData.ticketId}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">STATUS</span>
                        <span className={`font-mono-code font-bold text-xs ${ticketData.checkInStatus === 'CHECKED_IN' ? 'text-[#34D399]' : 'text-[#38BDF8]'}`}>
                          {ticketData.checkInStatus === 'CHECKED_IN' ? 'CHECKED IN' : 'VALID & UNUSED'}
                        </span>
                      </div>
                    </div>

                    {/* Security Notice */}
                    <div className="p-3.5 rounded-xl bg-[#0C2C4A] border border-[#164468] flex items-start gap-2.5 text-[#9DB8CF] text-xs">
                      <span className="material-symbols-outlined text-[#38BDF8] text-[18px] shrink-0 mt-0.5">verified_user</span>
                      <p className="leading-relaxed">
                        Ticket <strong className="text-white font-mono-code">{ticketData.ticketId}</strong> is cryptographically signed and tied to <strong className="text-white">{ticketData.fullName}</strong>. Present this pass at Gate 01 entry turnstiles.
                      </p>
                    </div>
                  </div>
                ) : ticketData.paymentStatus === 'PAYMENT_SUBMITTED' ? (
                  /* ---------------------------------------------------- */
                  /* STATE 2: UTR SUBMITTED -> AWAITING ADMIN APPROVAL    */
                  /* ---------------------------------------------------- */
                  <div className="p-6 rounded-2xl bg-[#0C2C4A]/95 backdrop-blur-2xl border border-[#FDBA74]/40 shadow-2xl flex flex-col gap-4">
                    <div className="flex items-center justify-between border-b border-[#164468] pb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-xl bg-[#FDBA74]/15 border border-[#FDBA74]/30 flex items-center justify-center text-[#FDBA74]">
                          <span className="material-symbols-outlined text-2xl animate-spin">hourglass_top</span>
                        </div>
                        <div>
                          <h3 className="font-display-title font-bold text-white text-base">Payment Under Verification</h3>
                          <p className="text-xs text-[#FDBA74]">Awaiting MSAP Treasury Admin Review</p>
                        </div>
                      </div>
                      <span className="px-3 py-1 rounded-full bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30 text-xs font-mono-code font-bold">
                        PENDING APPROVAL
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-[#061A2E] p-4 rounded-xl border border-[#164468]">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[#9DB8CF] font-mono-code text-[10px]">CANDIDATE</span>
                        <span className="font-bold text-white text-sm">{ticketData.fullName}</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[#9DB8CF] font-mono-code text-[10px]">REGISTRATION ID</span>
                        <span className="font-mono-code font-bold text-[#38BDF8] text-sm">{ticketData.registrationId || 'REG-????'}</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[#9DB8CF] font-mono-code text-[10px]">SUBMITTED BANK UTR</span>
                        <span className="font-mono-code font-bold text-[#34D399] text-sm tracking-wider">{ticketData.paymentUtr || 'Submitted'}</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[#9DB8CF] font-mono-code text-[10px]">AMOUNT DUE</span>
                        <span className="font-bold text-white text-sm">₹{eventSettings.registrationPrice}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 text-xs text-[#9DB8CF] bg-[#103A5F]/40 p-3.5 rounded-xl border border-[#164468]">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#38BDF8] animate-ping shrink-0"></span>
                      <span>
                        Live verification sync is running. Once our council approves your transaction, your official Master Entry Ticket will unlock immediately right here.
                      </span>
                    </div>

                    {/* Resubmit UTR if typo */}
                    <div className="pt-2 border-t border-[#164468]/60 flex flex-col gap-2">
                      <span className="text-[11px] text-[#9DB8CF]">Need to correct your UTR? You can resubmit:</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Enter 12-digit UTR"
                          value={utrInput}
                          onChange={(e) => setUtrInput(e.target.value)}
                          className="flex-1 bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-xs font-mono-code text-white border border-[#164468] outline-none focus:border-[#38BDF8]"
                        />
                        <button
                          onClick={handleSubmitUtr}
                          disabled={utrSubmitting}
                          className="px-4 py-2.5 rounded-xl bg-[#38BDF8] hover:bg-[#7DD3FC] text-[#061A2E] text-xs font-bold transition-all cursor-pointer disabled:opacity-50"
                        >
                          {utrSubmitting ? 'Updating...' : 'Update UTR'}
                        </button>
                      </div>
                      {utrMessage && (
                        <div className="text-xs p-2 rounded-lg bg-[#061A2E] border border-[#164468] text-white font-mono-code">
                          {utrMessage}
                        </div>
                      )}
                    </div>
                  </div>
                ) : ticketData.paymentStatus === 'REJECTED' ? (
                  /* ---------------------------------------------------- */
                  /* STATE 3: PAYMENT REJECTED -> RESUBMIT UTR            */
                  /* ---------------------------------------------------- */
                  <div className="p-6 rounded-2xl bg-[#0C2C4A]/95 backdrop-blur-2xl border border-[#FB7185]/40 shadow-2xl flex flex-col gap-4">
                    <div className="flex items-center gap-3 border-b border-[#164468] pb-3">
                      <div className="w-11 h-11 rounded-xl bg-[#FB7185]/15 border border-[#FB7185]/30 flex items-center justify-center text-[#FB7185]">
                        <span className="material-symbols-outlined text-2xl">error</span>
                      </div>
                      <div>
                        <h3 className="font-display-title font-bold text-white text-base">Payment Reference Rejected</h3>
                        <p className="text-xs text-[#FB7185]">
                          {ticketData.rejectionReason || 'The payment reference could not be verified in the bank statement.'}
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-[#9DB8CF] leading-relaxed">
                      Please ensure ₹{eventSettings.registrationPrice} was paid to UPI ID <strong className="text-white font-mono-code">msap.freshers26@icici</strong>, then enter your valid 12-digit UTR reference below:
                    </p>

                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-mono-code font-bold text-[#9DB8CF]">NEW BANK UTR / TXN NUMBER</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Enter 12-digit UTR number"
                          value={utrInput}
                          onChange={(e) => setUtrInput(e.target.value)}
                          className="flex-1 bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-sm font-mono-code text-white border border-[#164468] outline-none focus:border-[#38BDF8]"
                        />
                        <button
                          onClick={handleSubmitUtr}
                          disabled={utrSubmitting}
                          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] text-xs font-bold shadow-md transition-all cursor-pointer disabled:opacity-50"
                        >
                          {utrSubmitting ? 'Submitting...' : 'Resubmit UTR'}
                        </button>
                      </div>
                      {utrMessage && (
                        <div className="text-xs p-2 rounded-lg bg-[#061A2E] border border-[#164468] text-white font-mono-code">
                          {utrMessage}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  /* ---------------------------------------------------- */
                  /* STATE 4: PENDING PAYMENT -> OFFICIAL UPI PORTAL      */
                  /* ---------------------------------------------------- */
                  <div id="digitalTicketCard" className="p-6 rounded-2xl bg-[#0C2C4A]/95 backdrop-blur-2xl border border-[#164468] shadow-2xl flex flex-col gap-5">
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-[#164468]/60 pb-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-[#103A5F] text-[#38BDF8] font-label-caps font-bold text-[10px]">
                            PAYMENT PORTAL
                          </span>
                          <h3 className="font-display-title font-bold text-white text-lg">UPI Payment & Ticket Issuance</h3>
                        </div>
                        <p className="text-xs text-[#9DB8CF] mt-0.5">
                          Pay ₹{eventSettings.registrationPrice} via UPI QR • Submit UTR to receive Master Ticket
                        </p>
                      </div>

                      <div className="px-3 py-1 rounded-full bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30 text-xs font-mono-code font-bold">
                        {ticketData.registrationId ? ticketData.registrationId : 'REGISTRATION PENDING'}
                      </div>
                    </div>

                    {/* Candidate Info Banner */}
                    {ticketData.fullName && (
                      <div className="p-3 rounded-xl bg-[#061A2E] border border-[#164468] flex items-center justify-between text-xs">
                        <div>
                          <span className="text-[#9DB8CF]">Registered: </span>
                          <strong className="text-white font-semibold">{ticketData.fullName}</strong>
                          <span className="text-[#38BDF8] font-mono-code ml-1.5">({ticketData.category})</span>
                        </div>
                        <span className="text-emerald-400 font-bold font-mono-code">Amount: ₹{eventSettings.registrationPrice}</span>
                      </div>
                    )}

                    {/* Payment QR Section */}
                    <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-[#061A2E] border border-[#164468] text-center">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#38BDF8]/10 text-[#38BDF8] text-[11px] font-mono-code font-bold border border-[#38BDF8]/30">
                        <span className="material-symbols-outlined text-sm">qr_code_2</span>
                        <span>OFFICIAL PAYMENT QR (SCAN TO PAY)</span>
                      </div>

                      <div className="p-3 rounded-2xl bg-white shadow-2xl border-2 border-[#38BDF8]/40">
                        <img
                          src="/payment-qr.jpg"
                          alt="MSAP 53rd Freshers Meet UPI Payment QR"
                          className="w-52 h-52 object-contain block rounded-lg"
                        />
                      </div>

                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs text-[#9DB8CF]">Scan with Google Pay, PhonePe, Paytm, or BHIM</span>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="font-mono-code text-xs text-[#EAF6FF] px-2.5 py-1 rounded-lg bg-[#0C2C4A] border border-[#164468]">
                            msap.freshers26@icici
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText('msap.freshers26@icici');
                              alert('UPI ID copied to clipboard: msap.freshers26@icici');
                            }}
                            className="px-2.5 py-1 rounded-lg bg-[#103A5F] hover:bg-[#164468] text-[#38BDF8] text-xs font-semibold cursor-pointer border border-[#164468] flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-sm">content_copy</span>
                            <span>Copy UPI</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* UTR Input Section */}
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-mono-code font-bold text-[#9DB8CF] flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[#38BDF8] text-base">receipt</span>
                          <span>ENTER 12-DIGIT BANK UTR / TRANSACTION ID</span>
                        </label>
                        <span className="text-[#FB7185] text-xs font-bold">*REQUIRED</span>
                      </div>

                      <input
                        type="text"
                        placeholder="e.g. 429381729012 (from your UPI receipt)"
                        value={utrInput}
                        onChange={(e) => setUtrInput(e.target.value)}
                        className="w-full bg-[#061A2E] px-4 py-3 rounded-xl text-sm font-mono-code text-white border border-[#164468] outline-none focus:border-[#38BDF8] tracking-wider placeholder:text-[#9DB8CF]/40 placeholder:tracking-normal"
                      />

                      {utrMessage && (
                        <div className="text-xs p-3 rounded-xl bg-[#061A2E] border border-[#164468] text-white font-mono-code">
                          {utrMessage}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={handleSubmitUtr}
                        disabled={utrSubmitting}
                        className="w-full mt-1 py-3.5 px-5 rounded-xl bg-gradient-to-r from-[#0284C7] via-[#38BDF8] to-[#7DD3FC] text-[#061A2E] font-bold text-sm shadow-[0_0_24px_rgba(56,189,248,0.4)] hover:shadow-[0_0_32px_rgba(56,189,248,0.6)] hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-lg">
                          {utrSubmitting ? 'progress_activity' : 'send'}
                        </span>
                        <span>{utrSubmitting ? 'Submitting Reference...' : 'Submit Payment Reference (UTR) for Approval'}</span>
                      </button>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#061A2E] border border-[#164468] flex items-start gap-2 text-[#9DB8CF] text-[11px]">
                      <span className="material-symbols-outlined text-[#FDBA74] text-base shrink-0 mt-0.5">info</span>
                      <p>
                        Your unique Master Entry Ticket with scannable entry QR will unlock once payment is verified by the council.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* ================= 3. BACKEND ZERO-LATENCY PIPELINE ================= */}
            <section className="flex flex-col gap-6 pt-6 border-t border-[#164468]/60">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#38BDF8]"></span>
                  <span className="font-label-caps text-[#38BDF8] uppercase">ZERO-LATENCY ARCHITECTURE</span>
                </div>
                <h2 className="font-headline-lg text-white tracking-tight font-display-title">
                  Automated Verification & Live Scanner Pipeline
                </h2>
              </div>

              {/* 4-Step Infographic Bento */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-3 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="w-8 h-8 rounded-lg bg-[#103A5F] flex items-center justify-center font-headline-sm text-[#38BDF8] font-mono-code font-bold">
                      01
                    </span>
                    <span className="material-symbols-outlined text-[#38BDF8] text-[24px]">assignment</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="font-headline-sm text-white">Google Form Intake</h3>
                    <p className="font-body-sm text-[#9DB8CF]">
                      Student fills credentials, category (Fresher/Senior), and inputs verified UPI payment transaction UTR.
                    </p>
                  </div>
                  <div className="mt-auto pt-2 flex items-center gap-1 text-[#38BDF8] font-label-caps">
                    <span className="material-symbols-outlined text-[14px]">bolt</span>
                    <span>EVENT-TRIGGERED</span>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-3 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="w-8 h-8 rounded-lg bg-[#103A5F] flex items-center justify-center font-headline-sm text-[#7DD3FC] font-mono-code font-bold">
                      02
                    </span>
                    <span className="material-symbols-outlined text-[#7DD3FC] text-[24px]">table_chart</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="font-headline-sm text-white">Sheets Row Sync</h3>
                    <p className="font-body-sm text-[#9DB8CF]">
                      Direct write into master locked Google Sheets database with auto-incremented serial number and status.
                    </p>
                  </div>
                  <div className="mt-auto pt-2 flex items-center gap-1 text-[#7DD3FC] font-label-caps">
                    <span className="material-symbols-outlined text-[14px]">sync</span>
                    <span>INSTANT SYNC</span>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-3 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="w-8 h-8 rounded-lg bg-[#103A5F] flex items-center justify-center font-headline-sm text-[#FDBA74] font-mono-code font-bold">
                      03
                    </span>
                    <span className="material-symbols-outlined text-[#FDBA74] text-[24px]">developer_board</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="font-headline-sm text-white">Apps Script Engine</h3>
                    <p className="font-body-sm text-[#9DB8CF]">
                      Serverless script computes HMAC signature, generates unique FM26-XXX pass and scannable QR payload.
                    </p>
                  </div>
                  <div className="mt-auto pt-2 flex items-center gap-1 text-[#FDBA74] font-label-caps">
                    <span className="material-symbols-outlined text-[14px]">lock</span>
                    <span>ENCRYPTED PASS</span>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-3 relative overflow-hidden">
                  <div className="flex items-center justify-between">
                    <span className="w-8 h-8 rounded-lg bg-[#103A5F] flex items-center justify-center font-headline-sm text-[#34D399] font-mono-code font-bold">
                      04
                    </span>
                    <span className="material-symbols-outlined text-[#34D399] text-[24px]">sensors</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="font-headline-sm text-white">Admin QR Scanner</h3>
                    <p className="font-body-sm text-[#9DB8CF]">
                      Council gate marshals scan digital voucher in &lt;400ms with real-time biometric check-in & anti-passback.
                    </p>
                  </div>
                  <div className="mt-auto pt-2 flex items-center gap-1 text-[#34D399] font-label-caps">
                    <span className="material-symbols-outlined text-[14px]">check_circle</span>
                    <span>1-TAP ADMIT</span>
                  </div>
                </div>
              </div>

              {/* ================= 4. GENESIS EXPERIENCE HIGHLIGHTS ================= */}
              <div className="flex flex-col gap-4 pt-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-headline-md text-white font-display-title">Genesis Experience Highlights</h3>
                  <span className="font-label-caps text-[#FDBA74] tracking-wider uppercase">02 OCT LINEUP</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="group relative rounded-2xl overflow-hidden bg-[#0C2C4A] border border-[#164468] flex flex-col">
                    <div className="h-44 w-full relative overflow-hidden bg-[#061A2E]">
                      <img
                        alt="Campus DJ Stage"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        src="https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=800&q=80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0C2C4A] via-[#0C2C4A]/40 to-transparent"></div>
                      <div className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-[#FB7185] text-[#061A2E] font-label-caps shadow-sm font-bold">
                        HEADLINER ACT
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-1">
                      <h4 className="font-headline-sm text-white font-display-title">Main Arena DJ & Kinetic Beats</h4>
                      <p className="font-body-sm text-[#9DB8CF]">
                        High-octane electro set featuring guest alumni producers with acoustic surround mapping in Pune Auditorium.
                      </p>
                    </div>
                  </div>

                  <div className="group relative rounded-2xl overflow-hidden bg-[#0C2C4A] border border-[#164468] flex flex-col">
                    <div className="h-44 w-full relative overflow-hidden bg-[#061A2E]">
                      <img
                        alt="Parametric Architecture Pavilion"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        src="https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=800&q=80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0C2C4A] via-[#0C2C4A]/40 to-transparent"></div>
                      <div className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-[#FDBA74] text-[#061A2E] font-label-caps shadow-sm font-bold">
                        DESIGN PAVILION
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-1">
                      <h4 className="font-headline-sm text-white font-display-title">Parametric Neon Photo Portals</h4>
                      <p className="font-body-sm text-[#9DB8CF]">
                        Crafted by senior architecture studios: interactive luminescence structures designed for cohort portraits.
                      </p>
                    </div>
                  </div>

                  <div className="group relative rounded-2xl overflow-hidden bg-[#0C2C4A] border border-[#164468] flex flex-col">
                    <div className="h-44 w-full relative overflow-hidden bg-[#061A2E]">
                      <img
                        alt="Campus Food and Mocktail Garden"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        src="https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0C2C4A] via-[#0C2C4A]/40 to-transparent"></div>
                      <div className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-[#38BDF8] text-[#061A2E] font-label-caps shadow-sm font-bold">
                        CULINARY OASIS
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-1">
                      <h4 className="font-headline-sm text-white font-display-title">Gourmet Treats & Mocktail Garden</h4>
                      <p className="font-body-sm text-[#9DB8CF]">
                        Complimentary artisan welcome sips, wood-fired bites, and sweet treats included in your current gala pass.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* ================= GOOGLE FORM MODAL ================= */}
      {showGoogleFormModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0C2C4A] border border-[#164468] rounded-2xl max-w-lg w-full p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#164468] pb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#38BDF8]">description</span>
                <h3 className="font-headline-sm text-white">Google Form Integration</h3>
              </div>
              <button
                onClick={() => setShowGoogleFormModal(false)}
                className="text-[#9DB8CF] hover:text-[#EAF6FF] cursor-pointer"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="text-sm text-[#9DB8CF] flex flex-col gap-3 leading-relaxed">
              <p>
                Student registrations can be submitted through the official <strong className="text-white">MSAP Google Form</strong>. Responses flow directly into <strong className="text-white">Google Sheets</strong>, where our <strong className="text-white">Google Apps Script Webhook</strong> synchronizes each entry into the MySQL backend.
              </p>
              <div className="p-3 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1 font-mono-code text-xs">
                <span className="text-[#38BDF8]">Google Form Fields:</span>
                <span className="text-[#9DB8CF]">• Full Candidate Name</span>
                <span className="text-[#9DB8CF]">• WhatsApp / Mobile Number</span>
                <span className="text-[#9DB8CF]">• Learner Email Address</span>
                <span className="text-[#9DB8CF]">• Student / Roll ID & Department</span>
                <span className="text-[#9DB8CF]">• Category: Fresher vs Senior</span>
                <span className="text-[#9DB8CF]">• UPI Payment Transaction UTR</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowGoogleFormModal(false)}
                className="px-4 py-2 rounded-xl bg-[#103A5F] hover:bg-[#164468] text-[#EAF6FF] text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setShowGoogleFormModal(false);
                  const regEl = document.getElementById('registrationForm');
                  if (regEl) regEl.scrollIntoView({ behavior: 'smooth' });
                }}
                className="px-4 py-2 rounded-xl bg-[#38BDF8] hover:bg-[#7DD3FC] text-[#061A2E] text-xs font-bold cursor-pointer transition-colors"
              >
                Use Quick On-Page Intake
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= FOOTER ================= */}
      <footer className="w-full bg-[#061A2E] border-t border-[#164468]/60 py-8">
        <div className="max-w-7xl mx-auto px-5 lg:px-12 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center md:items-start gap-1">
            <div className="flex items-center gap-2">
              <span className="font-headline-sm text-white tracking-tight font-display-title">
                MSAP 53rd Freshers' Meet 2026
              </span>
              <span className="px-2 py-0.5 rounded-full bg-[#103A5F] font-mono-code text-[11px] text-[#FDBA74] font-bold">
                VOUCHER ENGINE V3.0
              </span>
            </div>
            <p className="font-body-sm text-[#9DB8CF] text-center md:text-left">
              Manipur Students' Association Pune (MSAP) • 02 OCT 2026 • Pune Campus
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0C2C4A] border border-[#164468]">
              <span className="material-symbols-outlined text-[#34D399] text-[16px]">sync_saved_locally</span>
              <span className="font-label-md text-white">Apps Script Live Sync Engine Active</span>
            </div>
            <span className="font-label-md text-[#9DB8CF]">© 2026 MSAP Student Council. All rights reserved.</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
