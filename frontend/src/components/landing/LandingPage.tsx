import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  ArrowRight, ArrowUpRight, BedDouble, Bell, Building2, CheckCircle2, ChevronDown,
  ClipboardList, LayoutGrid, MapPin, Search, Sparkles, TrendingUp, Users, Zap,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

/* ================================================================== */
/* Tokens                                                              */
/* ================================================================== */
const G = '#0D1C42', G2 = '#0D1C42', LIME = '#EAD3DB', IVORY = '#FFFCFA',
      INK = '#0D1C42', SAGE = '#F7E9EE', CORAL = '#B34A68', MUT = '#800020';

/* ================================================================== */
/* Motion primitives                                                   */
/* ================================================================== */
const Reveal: React.FC<{ children: React.ReactNode; delay?: number; className?: string }> =
  ({ children, delay = 0, className }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [inView, setInView] = useState(false);
    useEffect(() => {
      const el = ref.current; if (!el) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setInView(true); return; }
      const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setInView(true); o.disconnect(); } },
        { threshold: 0.12 });
      o.observe(el); return () => o.disconnect();
    }, []);
    return <div ref={ref} className={`lp-reveal ${inView ? 'lp-in' : ''} ${className || ''}`}
      style={{ animationDelay: `${delay}ms` }}>{children}</div>;
  };

const Eyebrow = ({ children, light }: { children: React.ReactNode; light?: boolean }) => (
  <p className="text-[11px] font-semibold uppercase tracking-[0.22em]"
    style={{ color: light ? LIME : G }}>{children}</p>);

const H2 = ({ children, light }: { children: React.ReactNode; light?: boolean }) => (
  <h2 className="text-[34px] sm:text-[44px] font-semibold leading-[1.08] tracking-[-0.02em]"
    style={{ color: light ? IVORY : INK }}>{children}</h2>);

const Avatar: React.FC<{ name: string; color?: string; size?: number }> = ({ name, color = G, size = 26 }) => (
  <span className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
    style={{ width: size, height: size, fontSize: size * 0.38, backgroundColor: color }}>
    {name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>);

const Dot = ({ c, pulse }: { c: string; pulse?: boolean }) => (
  <span className={`inline-block h-1.5 w-1.5 rounded-full ${pulse ? 'animate-pulse' : ''}`}
    style={{ backgroundColor: c }} />);

/** Hospitality image with graceful sage fallback. */
const Img: React.FC<{ src: string; alt: string; cls?: string; eager?: boolean }> = ({ src, alt, cls, eager }) => {
  const [err, setErr] = useState(false);
  return <div className={`relative overflow-hidden ${cls || ''}`} style={{ backgroundColor: SAGE }}>
    {err
      ? <div className="flex h-full w-full items-center justify-center" style={{ backgroundColor: G }}>
          <BedDouble size={34} style={{ color: LIME }} /></div>
      : <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} onError={() => setErr(true)}
          className="h-full w-full object-cover transition-transform duration-700 hover:scale-[1.02]" />}
  </div>;
};

/** Count-up number when scrolled into view (skips on reduced-motion). */
const CountUp: React.FC<{ to: number; suffix?: string; className?: string }> = ({ to, suffix = '', className }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const o = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || started.current) return;
      started.current = true;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(to); return; }
      const t0 = performance.now(), D = 1200;
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / D), ease = 1 - Math.pow(1 - p, 3);
        setV(Math.round(to * ease));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    o.observe(el); return () => o.disconnect();
  }, [to]);
  return <span ref={ref} className={`tabular-nums ${className || ''}`}>{v}{suffix}</span>;
};

/* Image sources — curated hospitality photography (Unsplash). */
const PHOTO = {
  heroMain: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1400&q=72',
  hotelRoom: 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&w=900&q=70',
  lobby: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&w=1200&q=70',
  apartment: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=900&q=70',
  housekeeping: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=900&q=70',
  exterior: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=1400&q=72',
  guestRoom: 'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=900&q=70',
  resort: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?auto=format&fit=crop&w=800&q=70',
  fullBleed: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?auto=format&fit=crop&w=1920&q=72',
};

/* ================================================================== */
/* §0 Navigation                                                       */
/* ================================================================== */
const NAV: [string, string][] = [
  ['Product', '#product'], ['Workflow', '#workflow'], ['Properties', '#properties'], ['Teams', '#teams']];

const Header: React.FC = () => {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 24);
    fn(); window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);
  return <header className="fixed inset-x-0 top-0 z-50 transition-all duration-300"
    style={scrolled ? { backgroundColor: 'rgba(247,247,242,0.88)', backdropFilter: 'blur(14px)', borderBottom: '1px solid rgba(18,60,50,0.08)' }
      : { backgroundColor: 'transparent' }}>
    <div className="mx-auto flex h-[64px] max-w-[1320px] items-center px-5 sm:px-8">
      <Link to="/" className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg text-[13px] font-bold"
          style={{ backgroundColor: G, color: LIME }}>A</span>
        <span className="text-[15px] font-bold tracking-[-0.01em]" style={{ color: INK }}>AiROS <span style={{ color: G }}>PMS</span></span>
      </Link>
      <nav aria-label="Primary" className="mx-auto hidden items-center gap-1 md:flex">
        {NAV.map(([l, h]) => <a key={h} href={h}
          className="rounded-md px-3 py-1.5 text-[13px] font-medium text-[#800020] transition-colors hover:bg-black/[0.04] hover:text-[#0D1C42]">{l}</a>)}
      </nav>
      <div className="ml-auto flex items-center gap-2 md:ml-0">
        <Link to="/login" className="rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-black/[0.04]"
          style={{ color: INK }}>Login</Link>
        <Link to="/signup" className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white transition-transform duration-150 hover:-translate-y-px"
          style={{ backgroundColor: G }}>Get Started</Link>
        <button aria-label="Menu" className="ml-1 rounded-md p-1.5 md:hidden" onClick={() => setOpen((v) => !v)}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke={INK} strokeWidth="1.5"><path d="M2 5h14M2 9h14M2 13h14" /></svg>
        </button>
      </div>
    </div>
    {open && <nav className="border-t px-5 pb-4 pt-2 md:hidden" style={{ backgroundColor: IVORY, borderColor: 'rgba(18,60,50,0.08)' }}>
      {NAV.map(([l, h]) => <a key={h} href={h} onClick={() => setOpen(false)}
        className="block rounded-md px-2 py-2 text-sm font-medium" style={{ color: INK }}>{l}</a>)}
    </nav>}
  </header>;
};

/* ================================================================== */
/* §1 Hero — editorial split over hospitality photography              */
/* ================================================================== */
const HeroFloat: React.FC<{ className?: string; delay?: string; children: React.ReactNode }> =
  ({ className, delay = '0s', children }) => (
    <div className={`lp-float z-10 rounded-xl border border-white/50 bg-white/95 p-3 shadow-[0_18px_44px_-14px_rgba(18,60,50,0.45)] backdrop-blur-sm ${className || ''}`}
      style={{ animationDelay: delay }}>{children}</div>);

const Hero: React.FC = () => (
  <section className="relative overflow-hidden px-5 pt-[120px] sm:px-8" style={{ backgroundColor: IVORY }}>
    <div className="mx-auto grid max-w-[1320px] items-center gap-10 pb-20 lg:grid-cols-[1fr_1.15fr]">
      {/* LEFT — editorial copy */}
      <div className="max-w-[560px]">
        <Reveal><Eyebrow>Property & workforce operations</Eyebrow></Reveal>
        <Reveal delay={90}>
          <h1 className="mt-4 text-[46px] font-bold leading-[1.03] tracking-[-0.03em] sm:text-[62px]" style={{ color: INK }}>
            Your properties.<br />Your people.<br />
            <span style={{ color: G }}>One intelligent<br />operation.</span></h1>
        </Reveal>
        <Reveal delay={170}>
          <p className="mt-6 max-w-[46ch] text-[15.5px] leading-relaxed" style={{ color: MUT }}>
            Manage every property, coordinate every team, and automate everyday work
            through one connected platform.</p>
        </Reveal>
        <Reveal delay={240}>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/signup" className="inline-flex items-center gap-2 rounded-lg px-6 py-3 text-[14px] font-semibold text-white transition-all duration-150 hover:-translate-y-0.5"
              style={{ backgroundColor: G }}>Get Started <ArrowRight size={15} /></Link>
            <a href="#workflow" className="inline-flex items-center gap-2 rounded-lg border px-6 py-3 text-[14px] font-semibold transition-colors hover:bg-white"
              style={{ borderColor: 'rgba(18,60,50,0.2)', color: INK }}>Explore AiROS PMS</a>
          </div>
          <ul className="mt-9 flex flex-wrap gap-x-7 gap-y-2">
            {['Property Management', 'Automated Work Allocation', 'Workforce Intelligence'].map((c) => (
              <li key={c} className="flex items-center gap-2 text-[12px] font-medium" style={{ color: INK }}>
                <span className="h-1 w-4 rounded-full" style={{ backgroundColor: LIME }} />{c}</li>))}
          </ul>
        </Reveal>
      </div>

      {/* RIGHT — hero photograph with floating product UI */}
      <Reveal delay={140} className="relative">
        <div className="relative lg:pl-10">
          <Img src={PHOTO.heroMain} eager alt="Premium hospitality property at dusk"
            cls="lp-img-in h-[440px] rounded-2xl sm:h-[560px]" />
          {/* floating task notification */}
          <HeroFloat className="absolute left-0 top-10 w-[215px] lg:-left-4" delay="0.4s">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: SAGE }}><Bell size={14} style={{ color: G }} /></span>
              <div><p className="text-[11px] font-semibold" style={{ color: INK }}>Task auto-assigned</p>
                <p className="text-[9.5px]" style={{ color: MUT }}>Round-robin · Zone C</p></div></div>
            <p className="mt-2 text-[9.5px] leading-relaxed" style={{ color: MUT }}>
              “Prepare Room 204” routed to Rahul Sharma</p>
          </HeroFloat>
          {/* operational stats card */}
          <HeroFloat className="absolute bottom-12 left-6 w-[190px] lg:left-2" delay="1.1s">
            <p className="text-[9px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUT }}>Operations · today</p>
            <div className="mt-1.5 flex items-end justify-between">
              <p className="text-[22px] font-bold tabular-nums" style={{ color: INK }}>126</p>
              <p className="pb-1 text-[9.5px]" style={{ color: MUT }}>tasks routed</p></div>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: '#F6F4F2' }}>
              <span className="lp-fill block h-full w-[75%] rounded-full" style={{ backgroundColor: G }} /></span>
            <p className="mt-1.5 text-[9.5px] font-medium" style={{ color: '#800020' }}>94% on track</p>
          </HeroFloat>
          {/* completion chip */}
          <HeroFloat className="absolute right-5 top-6 flex items-center gap-1.5 !rounded-full px-3.5 py-2" delay="0.8s">
            <CheckCircle2 size={14} style={{ color: '#16865B' }} />
            <span className="whitespace-nowrap text-[11px] font-semibold" style={{ color: INK }}>Room 204 ready · verified</span>
          </HeroFloat>
          {/* employee chip */}
          <HeroFloat className="absolute bottom-5 right-6 flex items-center gap-2" delay="1.6s">
            <Avatar name="Priya Mehta" size={26} />
            <div className="text-left"><p className="text-[10.5px] font-semibold" style={{ color: INK }}>Priya Mehta</p>
              <p className="text-[9px]" style={{ color: MUT }}>Front desk · on duty</p></div>
            <Dot c="#800020" pulse />
          </HeroFloat>
        </div>
      </Reveal>
    </div>
  </section>
);

/* ================================================================== */
/* §2 Pillars — compact editorial strip                                */
/* ================================================================== */
const PILLARS: [string, string, React.ReactNode, string][] = [
  ['01', 'Property visibility', <LayoutGrid size={18} />,
    "Know what's happening across properties, rooms and operational zones."],
  ['02', 'Intelligent work allocation', <Zap size={18} />,
    'Distribute responsibilities and keep teams organized — automatically.'],
  ['03', 'Real-time operational control', <TrendingUp size={18} />,
    'Monitor progress, completion and workforce activity in one place.'],
];

const Pillars: React.FC = () => (
  <section id="product" className="px-5 py-20 sm:px-8" style={{ backgroundColor: '#ffffff' }}>
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Why AiROS</Eyebrow>
        <H2>Everything connected.<br />Nothing overlooked.</H2>
      </Reveal>
      <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border md:grid-cols-3" style={{ borderColor: '#C3D6F0', backgroundColor: '#C3D6F0' }}>
        {PILLARS.map(([n, t, icon, d], i) => (
          <Reveal key={n} delay={i * 80}>
            <div className="group h-full p-8 transition-colors duration-200 hover:bg-[#FFFFFF]" style={{ backgroundColor: '#ffffff' }}>
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: SAGE, color: G }}>{icon}</span>
                <span className="text-[26px] font-bold" style={{ color: '#EAD3DB' }}>{n}</span>
              </div>
              <h3 className="mt-6 text-[17px] font-semibold" style={{ color: INK }}>{t}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: MUT }}>{d}</p>
            </div>
          </Reveal>))}
      </div>
    </div>
  </section>
);

/* ================================================================== */
/* §3 Business impact — dark, lime count-ups (illustrative)            */
/* ================================================================== */
const IMPACT: [number, string, string][] = [
  [20, '%', 'faster daily operations'],
  [30, '%', 'less manual coordination'],
  [25, '%', 'faster task allocation'],
  [95, '%', 'task completion visibility']];

const Impact: React.FC = () => (
  <section className="relative overflow-hidden px-5 py-24 sm:px-8" style={{ backgroundColor: G }}>
    <div className="pointer-events-none absolute -right-24 top-0 h-72 w-72 rounded-full opacity-[0.10]" style={{ backgroundColor: LIME }} />
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="max-w-[720px]">
        <Eyebrow light>Operational outcomes</Eyebrow>
        <h2 className="mt-3 text-[34px] font-semibold leading-[1.08] tracking-[-0.02em] text-white sm:text-[46px]">
          Better coordinated operations.<br /><span style={{ color: LIME }}>Measurable business impact.</span></h2>
        <p className="mt-4 max-w-[56ch] text-[15px] leading-relaxed text-white/70">
          Bring property management and workforce operations together to reduce manual
          coordination, improve visibility and keep everyday work moving.</p>
      </Reveal>
      <div className="mt-14 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 lg:grid-cols-4" style={{ backgroundColor: 'rgba(255,255,255,0.10)' }}>
        {IMPACT.map(([n, suf, l], i) => (
          <Reveal key={l} delay={i * 90}>
            <div className="h-full px-7 py-9" style={{ backgroundColor: G }}>
              <p className="text-[44px] font-bold leading-none sm:text-[58px]" style={{ color: LIME }}>
                <CountUp to={n} />{suf}</p>
              <p className="mt-3 text-[12.5px] font-medium text-white/80">{l}</p>
            </div>
          </Reveal>))}
      </div>
      <Reveal delay={200}>
        <p className="mt-4 text-[11px] text-white/45">* Illustrative directional figures shown for demonstration.</p>
      </Reveal>
    </div>
  </section>
);

/* ================================================================== */
/* §4 Hospitality editorial — asymmetric photography                   */
/* ================================================================== */
const Hospitality: React.FC = () => (
  <section className="px-5 py-24 sm:px-8" style={{ backgroundColor: IVORY }}>
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Built for hospitality</Eyebrow>
        <H2>Every property has moving parts.<br />Bring them together.</H2>
      </Reveal>
      <div className="mt-12 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-rows-2">
        <Reveal className="col-span-2 row-span-2">
          <div className="relative h-full min-h-[320px] lg:min-h-[480px]">
            <Img src={PHOTO.lobby} alt="Modern hotel lobby interior" cls="h-full w-full rounded-2xl" />
            {/* property overlay panel */}
            <div className="absolute bottom-5 left-5 rounded-xl border border-white/40 bg-white/95 p-4 shadow-[0_16px_40px_-14px_rgba(18,60,50,0.4)] backdrop-blur-sm">
              <p className="text-[9px] font-semibold uppercase tracking-[0.1em]" style={{ color: MUT }}>Property overview</p>
              <p className="mt-1 text-[15px] font-semibold" style={{ color: INK }}>Zostel Mumbai</p>
              <div className="mt-2 flex items-center gap-4 text-[11px]" style={{ color: MUT }}>
                <span><b className="tabular-nums" style={{ color: INK }}>42</b> rooms</span>
                <span><b className="tabular-nums" style={{ color: INK }}>18</b> team members</span>
                <span className="flex items-center gap-1" style={{ color: '#800020' }}><Dot c="#800020" />Active</span>
              </div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={100}><Img src={PHOTO.hotelRoom} alt="Premium hotel room interior" cls="h-[232px] w-full rounded-2xl lg:h-full" /></Reveal>
        <Reveal delay={160}><Img src={PHOTO.apartment} alt="Serviced apartment living space" cls="h-[232px] w-full rounded-2xl lg:h-full" /></Reveal>
        <Reveal delay={220}><Img src={PHOTO.housekeeping} alt="Housekeeping operations in progress" cls="h-[232px] w-full rounded-2xl lg:h-full" /></Reveal>
        <Reveal delay={280}><Img src={PHOTO.guestRoom} alt="Guest suite with city view" cls="h-[232px] w-full rounded-2xl lg:h-full" /></Reveal>
      </div>
    </div>
  </section>
);

/* ================================================================== */
/* §5 Automated work allocation — wide animated workflow               */
/* ================================================================== */
const STAGES: [string, string, string, string][] = [
  ['Created', 'Room preparation required', 'System · check-out trigger', '#A56514'],
  ['Assigned', 'Rahul Sharma — Housekeeping', 'Round-robin · Zone C', '#3478D4'],
  ['In progress', 'Room cleaning underway', 'Checklist · 6 of 9 items', '#3478D4'],
  ['Completed', 'Verified & room ready', 'Approved by supervisor', '#16865B']];

const Workflow: React.FC = () => (
  <section id="workflow" className="px-5 py-24 sm:px-8" style={{ backgroundColor: '#ffffff' }}>
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="max-w-[760px]">
        <Eyebrow>Automated work allocation</Eyebrow>
        <H2>Work doesn't get lost.<br />It gets allocated, tracked and completed.</H2>
        <p className="mt-4 max-w-[56ch] text-[15px] leading-relaxed" style={{ color: MUT }}>
          From the moment a task is created to the moment it's completed, AiROS PMS keeps
          every responsibility connected.</p>
      </Reveal>
      <div className="mt-14 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        {/* live task card + 4-stage flow */}
        <Reveal>
          <div className="rounded-2xl border p-6 sm:p-8" style={{ borderColor: '#C3D6F0', backgroundColor: '#FFFFFF' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <Avatar name="Rahul Sharma" size={34} />
                <div><p className="text-[15px] font-semibold" style={{ color: INK }}>Prepare Room 204</p>
                  <p className="text-[11px]" style={{ color: MUT }}>Rahul Sharma · Housekeeping · Zone C</p></div>
              </div>
              <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ backgroundColor: '#FDF3E2', color: CORAL }}>High priority</span>
            </div>
            {/* connected stages */}
            <div className="relative mt-9">
              <div className="absolute left-[5%] right-[5%] top-[15px] h-[3px] rounded-full" style={{ backgroundColor: '#EAD3DB' }} />
              <div className="lp-grow-x absolute left-[5%] top-[15px] h-[3px] rounded-full" style={{ width: '90%', background: `linear-gradient(90deg, #A56514, #3478D4, #800020)` }} />
              <ol className="relative grid grid-cols-4">
                {STAGES.map(([t, d, s, c], i) => (
                  <Reveal key={t} delay={i * 150}>
                    <li className="text-center">
                      <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full border-2 bg-white"
                        style={{ borderColor: c }}>
                        {i === 3 ? <CheckCircle2 size={14} style={{ color: c }} />
                          : <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c }} />}
                      </span>
                      <p className="mt-2.5 text-[12px] font-semibold" style={{ color: INK }}>{t}</p>
                      <p className="mx-auto mt-1 max-w-[150px] text-[10.5px] leading-snug" style={{ color: MUT }}>{d}</p>
                      <p className="mt-0.5 text-[9.5px]" style={{ color: '#7FA8CE' }}>{s}</p>
                    </li>
                  </Reveal>))}
              </ol>
            </div>
          </div>
        </Reveal>
        {/* operational summary */}
        <Reveal delay={140}>
          <div className="h-full rounded-2xl p-6 text-white sm:p-7" style={{ backgroundColor: G }}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'rgba(199,243,107,0.8)' }}>Operational summary</p>
            <div className="mt-5 space-y-4">
              {[['Tasks assigned', '24', 'w-full', LIME], ['In progress', '08', 'w-1/3', '#7FA8CE'], ['Completed', '16', 'w-2/3', '#EAD3DB']].map(([l, v, w, c]) => (
                <div key={l as string}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] text-white/70">{l}</span>
                    <span className="text-[20px] font-bold tabular-nums" style={{ color: c as string }}>{v}</span>
                  </div>
                  <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/10">
                    <span className={`lp-fill block h-full rounded-full ${w}`} style={{ backgroundColor: c as string }} /></span>
                </div>))}
            </div>
            <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.06] p-3.5">
              <p className="flex items-center gap-1.5 text-[11px] text-white/80"><Sparkles size={12} style={{ color: LIME }} />
                Every assignment recorded in the allocation ledger — fully auditable.</p>
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  </section>
);

/* ================================================================== */
/* §6 Workforce analytics — sage section, real charts                  */
/* ================================================================== */
const TEAM: [string, string, number, number, string][] = [
  ['Rahul Sharma', 'Housekeeping', 6, 4, 'On duty'],
  ['Priya Mehta', 'Front desk', 4, 3, 'On duty'],
  ['Amit Verma', 'Maintenance', 7, 5, 'On duty'],
  ['Sana Khan', 'Housekeeping', 3, 2, 'On break'],
  ['Vikram Rao', 'Operations', 5, 4, 'On duty']];
const DEPT: [string, number, number][] = [
  ['Housekeeping', 82, 76], ['Front desk', 44, 41], ['Maintenance', 31, 27], ['Operations', 22, 20]];
const TREND = [38, 45, 42, 58, 52, 66, 61, 72, 69, 82, 78, 94];

const Workforce: React.FC = () => {
  const W = 320, H = 110;
  const pts = TREND.map((v, i) => `${(i / (TREND.length - 1)) * W},${H - (v / 100) * H}`).join(' ');
  return <section id="teams" className="px-5 py-24 sm:px-8" style={{ backgroundColor: SAGE }}>
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Workforce intelligence</Eyebrow>
        <H2>See how work moves<br />across your teams.</H2>
      </Reveal>
      <div className="mt-12 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* dashboard panel */}
        <Reveal>
          <div className="rounded-2xl bg-white p-6 shadow-[0_20px_50px_-24px_rgba(18,60,50,0.25)] sm:p-8">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[['Employees active', '42', ''], ['Tasks assigned', '126', ''], ['Completed today', '94', ''], ['Pending review', '08', '']].map(([l, v]) => (
                <div key={l} className="rounded-xl border px-3.5 py-3" style={{ borderColor: '#C3D6F0' }}>
                  <p className="text-[22px] font-bold tabular-nums" style={{ color: INK }}>{v}</p>
                  <p className="text-[9.5px] uppercase tracking-wide" style={{ color: MUT }}>{l}</p></div>))}
            </div>
            {/* workload bars */}
            <div className="mt-8">
              <p className="text-[12px] font-semibold" style={{ color: INK }}>Workload by department</p>
              <div className="mt-4 space-y-3">
                {DEPT.map(([d, alloc, done]) => (
                  <div key={d}>
                    <div className="flex justify-between text-[10.5px]" style={{ color: MUT }}>
                      <span>{d}</span><span className="tabular-nums"><b style={{ color: INK }}>{done}</b> / {alloc} done</span></div>
                    <span className="relative mt-1 block h-2 overflow-hidden rounded-full" style={{ backgroundColor: '#F7E9EE' }}>
                      <span className="lp-fill absolute inset-y-0 left-0 rounded-full" style={{ width: `${alloc}%`, backgroundColor: '#EAD3DB' }} />
                      <span className="lp-fill absolute inset-y-0 left-0 rounded-full" style={{ width: `${done}%`, backgroundColor: G, animationDelay: '.15s' }} />
                    </span>
                  </div>))}
              </div>
            </div>
            {/* completion trend */}
            <div className="mt-8">
              <div className="flex items-baseline justify-between">
                <p className="text-[12px] font-semibold" style={{ color: INK }}>Completion trend · 12 weeks</p>
                <p className="text-[10.5px] font-medium" style={{ color: '#800020' }}>▲ 94% this week</p></div>
              <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 h-[110px] w-full" role="img" aria-label="Task completion trend rising to 94%">
                <defs><linearGradient id="lpArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={G} stopOpacity="0.22" /><stop offset="100%" stopColor={G} stopOpacity="0" />
                </linearGradient></defs>
                {[0, 1, 2].map((i) => <line key={i} x1="0" x2={W} y1={H * (i + 1) / 4} y2={H * (i + 1) / 4} stroke="#F7E9EE" />)}
                <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#lpArea)" />
                <polyline points={pts} fill="none" stroke={G} strokeWidth="2.5" strokeLinejoin="round" className="lp-dash" />
                <circle cx={W} cy={H - 0.94 * H} r="4" fill={LIME} stroke={G} strokeWidth="2" />
              </svg>
            </div>
          </div>
        </Reveal>
        {/* employee activity */}
        <Reveal delay={120}>
          <div className="flex h-full flex-col rounded-2xl bg-white p-6 shadow-[0_20px_50px_-24px_rgba(18,60,50,0.25)] sm:p-7">
            <p className="text-[13px] font-semibold" style={{ color: INK }}>Team activity · today</p>
            <ul className="mt-4 flex-1 divide-y" style={{ borderColor: '#F6F4F2' }}>
              {TEAM.map(([n, dept, alloc, done, st]) => (
                <li key={n} className="flex items-center gap-3 py-3">
                  <Avatar name={n} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium" style={{ color: INK }}>{n}</p>
                    <p className="text-[10px]" style={{ color: MUT }}>{dept}</p>
                    <span className="mt-1.5 block h-1 w-full max-w-[120px] overflow-hidden rounded-full" style={{ backgroundColor: '#F6F4F2' }}>
                      <span className="lp-fill block h-full rounded-full" style={{ width: `${done / alloc * 100}%`, backgroundColor: G }} /></span>
                  </div>
                  <div className="text-right">
                    <p className="text-[13px] font-semibold tabular-nums" style={{ color: INK }}>{done}/{alloc}</p>
                    <p className="flex items-center justify-end gap-1 text-[9px]" style={{ color: st === 'On duty' ? '#16865B' : '#A56514' }}>
                      <Dot c={st === 'On duty' ? '#16865B' : '#A56514'} />{st}</p>
                  </div>
                </li>))}
            </ul>
            <p className="mt-4 rounded-lg px-3 py-2 text-[10.5px]" style={{ backgroundColor: '#FFFCFA', color: MUT }}>
              Coordination and workload visibility — not surveillance.</p>
          </div>
        </Reveal>
      </div>
    </div>
  </section>;
};

/* ================================================================== */
/* §7 Property portfolio — image-led                                   */
/* ================================================================== */
const PROPS2: [string, string, string, string, number, number][] = [
  ['Harbourview Residency', 'Mumbai · Colaba', 'hotel', PHOTO.exterior, 148, 12],
  ['The Meridian Suites', 'Goa · Candolim', 'hotel', PHOTO.resort, 64, 7],
  ['Aster Court Hotel', 'Bangalore · Indiranagar', 'hotel', PHOTO.lobby, 96, 9],
  ['Palm Lane Apartments', 'Pune · Koregaon Park', 'serviced apartment', PHOTO.apartment, 38, 5]];

const Portfolio: React.FC = () => (
  <section id="properties" className="px-5 py-24 sm:px-8" style={{ backgroundColor: '#ffffff' }}>
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Property portfolio</Eyebrow>
          <H2>One view across<br />every property.</H2>
        </div>
        {/* floating portfolio summary */}
        <div className="flex gap-6 rounded-2xl border px-6 py-4" style={{ borderColor: '#C3D6F0', backgroundColor: '#FFFFFF' }}>
          {[['Properties', '08'], ['Rooms', '346'], ['Active teams', '42'], ['Ongoing tasks', '126']].map(([l, v]) => (
            <div key={l} className="text-center">
              <p className="text-[20px] font-bold tabular-nums" style={{ color: G }}>{v}</p>
              <p className="text-[9.5px]" style={{ color: MUT }}>{l}</p></div>))}
        </div>
      </Reveal>
      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        {/* main property */}
        <Reveal>
          <div className="group relative h-[380px] overflow-hidden rounded-2xl sm:h-[460px]">
            <Img src={PROPS2[0][3]} alt={`${PROPS2[0][0]} — ${PROPS2[0][2]}`} cls="h-full w-full" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 45%, rgba(18,33,30,0.78))' }} />
            <span className="absolute left-5 top-5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold text-white"
              style={{ backgroundColor: 'rgba(18,60,50,0.72)' }}><Dot c={LIME} pulse />Operational</span>
            <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between p-6">
              <div>
                <p className="text-[22px] font-semibold text-white">{PROPS2[0][0]}</p>
                <p className="mt-1 flex items-center gap-1.5 text-[12px] text-white/80"><MapPin size={11} />{PROPS2[0][1]}</p>
              </div>
              <div className="flex gap-2">
                {[['Rooms', PROPS2[0][4]], ['Staff', PROPS2[0][5]]].map(([l, v]) => (
                  <div key={l} className="rounded-lg bg-white/10 px-3 py-1.5 text-center backdrop-blur-sm">
                    <p className="text-[15px] font-bold text-white tabular-nums">{v}</p>
                    <p className="text-[8.5px] uppercase tracking-wide text-white/70">{l}</p></div>))}
              </div>
            </div>
          </div>
        </Reveal>
        {/* secondary properties */}
        <div className="grid gap-4">
          {PROPS2.slice(1).map(([name, loc, kind, img, rooms, staff], i) => (
            <Reveal key={name} delay={i * 90}>
              <div className="group relative flex h-[140px] overflow-hidden rounded-2xl">
                <Img src={img} alt={`${name} — ${kind}`} cls="w-[38%]" />
                <div className="flex flex-1 flex-col justify-between border border-l-0 p-4" style={{ borderColor: '#C3D6F0', backgroundColor: '#FFFFFF' }}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[14px] font-semibold" style={{ color: INK }}>{name}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-[10.5px]" style={{ color: MUT }}><MapPin size={9} />{loc}</p>
                    </div>
                    <span className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold"
                      style={{ backgroundColor: SAGE, color: '#800020' }}><Dot c="#800020" />Live</span>
                  </div>
                  <p className="text-[11px]" style={{ color: MUT }}>
                    <b className="tabular-nums" style={{ color: INK }}>{rooms}</b> rooms · <b className="tabular-nums" style={{ color: INK }}>{staff}</b> staff</p>
                </div>
              </div>
            </Reveal>))}
        </div>
      </div>
    </div>
  </section>
);

/* ================================================================== */
/* §8 Full-bleed photographic statement                                */
/* ================================================================== */
const FullBleed: React.FC = () => (
  <section className="relative h-[520px] overflow-hidden sm:h-[620px]">
    <Img src={PHOTO.fullBleed} alt="Resort property at dusk — hospitality operations behind the scenes"
      cls="h-full w-full" />
    <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(12,44,36,0.82) 0%, rgba(12,44,36,0.35) 60%, transparent 100%)' }} />
    <div className="absolute inset-0 mx-auto flex max-w-[1320px] items-center px-5 sm:px-8">
      <Reveal className="max-w-[560px]">
        <h2 className="text-[36px] font-semibold leading-[1.08] tracking-[-0.02em] text-white sm:text-[52px]">
          Great guest experiences<br />begin behind<br />
          <span style={{ color: LIME }}>the scenes.</span></h2>
        <p className="mt-5 max-w-[40ch] text-[15px] leading-relaxed text-white/80">
          Well-coordinated teams. Clear responsibilities. Operations that keep moving.</p>
      </Reveal>
    </div>
  </section>
);

/* ================================================================== */
/* §9 Feature bento — asymmetric                                       */
/* ================================================================== */
const Bento: React.FC = () => (
  <section id="features" className="px-5 py-24 sm:px-8" style={{ backgroundColor: IVORY }}>
    <div className="mx-auto max-w-[1320px]">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Platform capabilities</Eyebrow>
        <H2>Everything your<br />operation needs.</H2>
      </Reveal>
      <div className="mt-12 grid gap-4 md:grid-cols-6">
        <Reveal className="md:col-span-3">
          <div className="group relative flex h-full min-h-[240px] flex-col justify-between overflow-hidden rounded-2xl p-7" style={{ backgroundColor: G }}>
            <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-20" style={{ backgroundColor: LIME }} />
            <div>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: 'rgba(199,243,107,0.14)', color: LIME }}><Zap size={18} /></span>
              <h3 className="mt-5 text-[20px] font-semibold text-white">Automated work allocation</h3>
              <p className="mt-2 max-w-[40ch] text-[13px] leading-relaxed text-white/70">
                Zone-aware round-robin pools, department eligibility, batch allocation and a
                complete audit trail.</p>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {['Zone pools', 'Batch routing', 'Manual override', 'Audit ledger'].map((f) => (
                <span key={f} className="rounded-full border border-white/20 px-3 py-1 text-[10.5px] text-white/85">{f}</span>))}
            </div>
          </div>
        </Reveal>
        <Reveal delay={80} className="md:col-span-3">
          <div className="group h-full rounded-2xl border bg-white p-7 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_34px_-16px_rgba(18,60,50,0.22)]" style={{ borderColor: '#C3D6F0' }}>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: SAGE, color: G }}><Building2 size={18} /></span>
            <h3 className="mt-4 text-[16px] font-semibold" style={{ color: INK }}>Multi-property management</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: MUT }}>Entire portfolios — rooms, floors, zones and washrooms — in one structured view.</p>
            {/* mini property rows */}
            <div className="mt-5 space-y-2">
              {[['Harbourview', 'Op', '#800020'], ['Meridian', 'Op', '#800020'], ['Aster Court', 'Setup', '#A56514']].map(([n, s, c]) => (
                <div key={n} className="flex items-center gap-2 rounded-lg border px-3 py-2" style={{ borderColor: '#F6F4F2' }}>
                  <Building2 size={12} style={{ color: G }} />
                  <span className="text-[11px] font-medium" style={{ color: INK }}>{n}</span>
                  <span className="ml-auto flex items-center gap-1 text-[9.5px]" style={{ color: c }}><Dot c={c} />{s}</span>
                </div>))}
            </div>
          </div>
        </Reveal>
        {[
          [<Users size={17} />, 'Employee management', 'Teams, roles, zones, shifts and leave — one roster.', 'md:col-span-2'],
          [<LayoutGrid size={17} />, 'Room & zone management', 'Rooms, dorms, beds, washrooms — structured hierarchy.', 'md:col-span-2'],
          [<ClipboardList size={17} />, 'Task tracking & review', 'Submissions, approvals, redos and photo evidence.', 'md:col-span-2'],
        ].map(([icon, t, d, cls], i) => (
          <Reveal key={t as string} delay={i * 70} className={cls as string}>
            <div className="h-full rounded-2xl border bg-white p-6 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_34px_-16px_rgba(18,60,50,0.2)]" style={{ borderColor: '#C3D6F0' }}>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: SAGE, color: G }}>{icon}</span>
              <h3 className="mt-3.5 text-[14.5px] font-semibold" style={{ color: INK }}>{t}</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: MUT }}>{d}</p>
            </div>
          </Reveal>))}
        <Reveal delay={120} className="md:col-span-4">
          <div className="flex h-full items-center justify-between gap-6 rounded-2xl p-7" style={{ backgroundColor: SAGE }}>
            <div>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: '#ffffff', color: G }}><TrendingUp size={18} /></span>
              <h3 className="mt-4 text-[16px] font-semibold" style={{ color: INK }}>Operational analytics</h3>
              <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed" style={{ color: MUT }}>
                Workload, completion, attendance and shift adherence — measurable operations, end to end.</p>
            </div>
            <div className="hidden items-end gap-1.5 sm:flex" aria-hidden>
              {[36, 52, 44, 68, 58, 80, 72, 95].map((h, i) => (
                <span key={i} className="lp-fill w-4 rounded-t" style={{ height: `${h * 0.9}px`, backgroundColor: i === 7 ? LIME : G, animationDelay: `${i * 50}ms` }} />))}
            </div>
          </div>
        </Reveal>
        <Reveal delay={180} className="md:col-span-2">
          <div className="h-full rounded-2xl border bg-white p-6" style={{ borderColor: '#C3D6F0' }}>
            <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: SAGE, color: G }}><Search size={17} /></span>
            <h3 className="mt-3.5 text-[14.5px] font-semibold" style={{ color: INK }}>Centralized management</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: MUT }}>Every property, person and task — one workspace.</p>
          </div>
        </Reveal>
      </div>
    </div>
  </section>
);

/* ================================================================== */
/* §10 Dark brand + §11 CTA + §12 Footer                               */
/* ================================================================== */
const Brand: React.FC = () => (
  <section id="brand" className="relative overflow-hidden px-5 py-28 sm:px-8" style={{ backgroundColor: G2 }}>
    <div className="pointer-events-none absolute -left-24 bottom-0 h-72 w-72 rounded-full opacity-[0.12]" style={{ backgroundColor: LIME }} />
    <div className="relative mx-auto grid max-w-[1320px] items-center gap-12 lg:grid-cols-[1.2fr_1fr]">
      <Reveal>
        <h2 className="text-[38px] font-bold leading-[1.06] tracking-[-0.02em] text-white sm:text-[54px]">
          Less manual coordination.<br /><span style={{ color: LIME }}>More operational control.</span></h2>
        <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-white/70">
          Give your teams the clarity to work — and your managers the visibility to lead.</p>
        <Link to="/signup" className="mt-8 inline-flex items-center gap-2 rounded-lg px-6 py-3 text-[14px] font-bold transition-transform duration-150 hover:-translate-y-0.5"
          style={{ backgroundColor: LIME, color: G2 }}>Explore AiROS PMS <ArrowRight size={15} /></Link>
      </Reveal>
      {/* floating UI composition */}
      <Reveal delay={140} className="relative hidden h-[300px] lg:block">
        <div className="lp-float absolute left-6 top-4 w-[210px] rounded-xl bg-white p-3.5 shadow-[0_18px_44px_-14px_rgba(0,0,0,0.4)]" style={{ animationDelay: '0.3s' }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: SAGE }}><Bell size={13} style={{ color: G }} /></span>
            <p className="text-[11px] font-semibold" style={{ color: INK }}>Task auto-assigned</p></div>
          <p className="mt-2 text-[9.5px]" style={{ color: MUT }}>“Inspect HVAC — Wing B” → Amit Verma</p>
        </div>
        <div className="lp-float absolute right-0 top-24 w-[180px] rounded-xl bg-white p-3.5 shadow-[0_18px_44px_-14px_rgba(0,0,0,0.4)]" style={{ animationDelay: '1s' }}>
          <p className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: MUT }}>Team availability</p>
          {[['Rahul S.', '#800020'], ['Priya M.', '#A56514']].map(([n, c]) => (
            <div key={n} className="mt-2 flex items-center gap-2">
              <Avatar name={n} size={18} /><span className="text-[9.5px] font-medium" style={{ color: INK }}>{n}</span>
              <Dot c={c} /></div>))}
        </div>
        <div className="lp-float absolute bottom-4 left-16 w-[190px] rounded-xl bg-white p-3.5 shadow-[0_18px_44px_-14px_rgba(0,0,0,0.4)]" style={{ animationDelay: '1.7s' }}>
          <p className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: MUT }}>Completion · today</p>
          <div className="mt-2 flex items-end gap-1">
            {[40, 55, 48, 68, 82, 94].map((h, i) => (
              <span key={i} className="flex-1 rounded-t" style={{ height: `${h * 0.5}px`, backgroundColor: i === 5 ? LIME : G }} />))}
          </div>
          <p className="mt-1.5 text-[10px] font-semibold" style={{ color: '#16865B' }}>94% done</p>
        </div>
      </Reveal>
    </div>
  </section>
);

const Cta: React.FC = () => (
  <section className="px-5 py-28 sm:px-8" style={{ backgroundColor: IVORY }}>
    <div className="mx-auto max-w-[760px] text-center">
      <Reveal>
        <H2>Bring every operation<br />together.</H2>
        <p className="mx-auto mt-5 max-w-[48ch] text-[15px] leading-relaxed" style={{ color: MUT }}>
          Discover a more connected way to manage properties, coordinate teams and keep work moving.</p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/signup" className="inline-flex items-center gap-2 rounded-lg px-7 py-3.5 text-[14px] font-bold transition-transform duration-150 hover:-translate-y-0.5"
            style={{ backgroundColor: G, color: '#ffffff' }}>Get Started <ArrowUpRight size={15} /></Link>
          <Link to="/login" className="inline-flex items-center gap-2 rounded-lg border px-7 py-3.5 text-[14px] font-semibold transition-colors hover:bg-white"
            style={{ borderColor: 'rgba(18,60,50,0.22)', color: INK }}>Login</Link>
        </div>
      </Reveal>
    </div>
  </section>
);

const FOOT: [string, [string, string][]][] = [
  ['Product', [['Features', '#features'], ['Workflow', '#workflow'], ['Properties', '#properties'], ['Teams', '#teams']]],
  ['Company', [['About', '#brand'], ['Contact', '#brand'], ['Careers', '#brand']]],
  ['Account', [['Login', '/login'], ['Get Started', '/signup'], ['Privacy Policy', '#'], ['Terms & Conditions', '#']]]];

const Footer: React.FC = () => (
  <footer className="border-t px-5 py-14 sm:px-8" style={{ backgroundColor: '#ffffff', borderColor: '#C3D6F0' }}>
    <div className="mx-auto grid max-w-[1320px] gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg text-[13px] font-bold" style={{ backgroundColor: G, color: LIME }}>A</span>
          <span className="text-[15px] font-bold" style={{ color: INK }}>AiROS <span style={{ color: G }}>PMS</span></span>
        </div>
        <p className="mt-4 max-w-[34ch] text-[13px] leading-relaxed" style={{ color: MUT }}>
          One intelligent workspace for property management, workforce coordination and
          automated work allocation.</p>
      </div>
      {FOOT.map(([title, links]) => (
        <nav key={title} aria-label={title}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: INK }}>{title}</p>
          <ul className="mt-4 space-y-2.5">
            {links.map(([l, h]) => <li key={l}>
              {h.startsWith('/') ? <Link to={h} className="text-[13px] transition-colors hover:text-[#0D1C42]" style={{ color: MUT }}>{l}</Link>
                : <a href={h} className="text-[13px] transition-colors hover:text-[#0D1C42]" style={{ color: MUT }}>{l}</a>}
            </li>)}
          </ul>
        </nav>))}
    </div>
    <div className="mx-auto mt-12 flex max-w-[1320px] items-center justify-between border-t pt-6 text-[11px]" style={{ borderColor: '#C3D6F0', color: MUT }}>
      <span>© 2026 AiROS PMS</span>
      <span>Built for modern property operations.</span>
    </div>
  </footer>
);

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */
/**
 * Public landing page — the entry point for unauthenticated visitors.
 * Authenticated users skip straight to their role's workspace.
 */
export const LandingPage: React.FC = () => {
  const { isAuthenticated, currentUser } = useApp();

  if (isAuthenticated && currentUser) {
    if (currentUser.role === 'super_admin') return <Navigate to="/admin/properties" replace />;
    if (currentUser.role === 'property_manager')
      return <Navigate to={`/property/${currentUser.property_uid}/overview`} replace />;
    return <Navigate to="/employee/tasks" replace />;
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: IVORY, fontFamily: "'Satoshi', system-ui, sans-serif" }}>
      <Header />
      <main>
        <Hero />
        <Pillars />
        <Impact />
        <Hospitality />
        <Workflow />
        <Workforce />
        <Portfolio />
        <FullBleed />
        <Bento />
        <Brand />
        <Cta />
      </main>
      <Footer />
    </div>
  );
};
