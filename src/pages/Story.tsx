import { rally, type Merchant } from '../chain';
import { Stamp, Trophy } from '../Stamp';
import { SLIDES_URL, REPO_URL, VOTE_ADDRESS } from '../links';
import { sats, ID, tr, switchLang, cost } from '../shared';

// ---- #/story: "A day of roaming Jogja", the rally told in six panels (media piece, BCH BLAZE Media Track).
// The art is the real stamps and trophy of the live rally; every number comes from the rally record.
export function Story() {
  const m = (id: number) => rally.merchants.find((x) => x.id === id) ?? rally.merchants[0];
  const [kopi, bakmi, sate, dawet] = [m(1), m(2), m(3), m(4)];
  const price = (x: Merchant, member = false) => sats(cost(x, member));
  const panels: { art: React.ReactNode; en: React.ReactNode; id: React.ReactNode; tag: string }[] = [
    {
      tag: '07:10',
      art: <div className="scene">🚉 <span>☕</span></div>,
      en: <>Rani steps off the train at Tugu with a phone, a Bitcoin Cash wallet and no plan. A poster on a warung by the station says <b>“{rally.name}: collect {rally.needed} stamps, get rewarded.”</b> No app to install. Just a QR.</>,
      id: <>Rani turun dari kereta di Tugu, bermodal ponsel, wallet Bitcoin Cash, dan tanpa rencana. Poster di warung dekat stasiun bertuliskan <b>“{rally.name}: kumpulkan {rally.needed} stamp, dapat hadiah.”</b> Tidak perlu pasang aplikasi. Cukup QR.</>,
    },
    {
      tag: '07:20',
      art: <Stamp m={kopi} inked size={150} />,
      en: <>{kopi.emoji} {kopi.name}. Rani pays {price(kopi)} and the stamp appears in the wallet <b>in the very same transaction</b>. The stall's covenant only lets a stamp out when the stall got paid. So the stamp isn't a promise of a visit. It is the visit.</>,
      id: <>{kopi.emoji} {kopi.name}. Rani membayar {price(kopi)} dan stamp muncul di wallet <b>di transaksi yang sama</b>. Covenant warung hanya mengeluarkan stamp kalau warung sudah dibayar. Jadi stamp bukan janji kunjungan. Stamp itu kunjungannya.</>,
    },
    {
      tag: '12:30',
      art: <div className="scene"><Stamp m={bakmi} inked size={120} /><span className="ring">🔔</span></div>,
      en: <>{bakmi.emoji} {bakmi.name} in Kotagede. Behind the wood fire, Pak Darto's old phone rings: the till heard the payment hit the network. He never has to check a screen to trust it.</>,
      id: <>{bakmi.emoji} {bakmi.name} di Kotagede. Di balik tungku, ponsel lama Pak Darto berbunyi: kasir mendengar pembayaran masuk ke jaringan. Dia tidak perlu memelototi layar untuk percaya.</>,
    },
    {
      tag: '19:00',
      art: <div className="scene stack"><Stamp m={kopi} inked size={90} /><Stamp m={bakmi} inked size={90} /><Stamp m={sate} inked size={90} /></div>,
      en: <>{sate.emoji} {sate.name}, satay on bicycle spokes. Three different stalls, three stamps, all bought by Rani's own key. Two stamps from the same stall wouldn't count, and neither would stamps bought from a friend.</>,
      id: <>{sate.emoji} {sate.name}, sate tusuk jeruji sepeda. Tiga warung berbeda, tiga stamp, semuanya dibeli kunci milik Rani sendiri. Dua stamp dari warung yang sama tidak dihitung, begitu juga stamp beli dari teman.</>,
    },
    {
      tag: '19:05',
      art: <Trophy name={rally.name} size={150} />,
      en: <>One tap: the three stamps burn, the rally vault checks them in a loop, pays Rani {sats(rally.reward)} and mints a trophy. The prize money was never in anyone's pocket{rally.levy ? <>, and because every stamp paid a levy into the pool, even stalls that collude can't drain it</> : null}.</>,
      id: <>Satu ketukan: tiga stamp dibakar, vault rally memeriksanya satu per satu, membayar Rani {sats(rally.reward)} dan mencetak trofi. Uang hadiah tidak pernah ada di kantong siapa pun{rally.levy ? <>, dan karena setiap stamp membayar levy ke pool, warung yang berkolusi pun tidak bisa mengurasnya</> : null}.</>,
    },
    {
      tag: tr('next day', 'besok'),
      art: <div className="scene"><Trophy name={rally.name} size={110} /><Stamp m={dawet} inked size={110} /></div>,
      en: <>{dawet.emoji} {dawet.name} at Beringharjo market. Rani shows the trophy: member price, {price(dawet, true)} instead of {price(dawet)}. The trophy comes straight back in the same transaction. It's a membership card nobody can fake or borrow.</>,
      id: <>{dawet.emoji} {dawet.name} di Pasar Beringharjo. Rani menunjukkan trofinya: harga member, {price(dawet, true)} bukan {price(dawet)}. Trofinya langsung kembali di transaksi yang sama. Kartu member yang tidak bisa dipalsukan atau dipinjam.</>,
    },
  ];
  return (
    <>
      <Banner />
      <main className="story">
        <p className="eyebrow">{rally.name} · {tr('a story in six panels', 'cerita dalam enam panel')}</p>
        <h1>{tr('A day of roaming Jogja', 'Sehari menjelajah Jogja')}</h1>
        <p className="lede">{tr('Jelajah means “to roam”. This is what a rally day looks like, on Bitcoin Cash mainnet.', 'Jelajah artinya menjelajah. Begini satu hari rally di mainnet Bitcoin Cash.')}</p>
        <ol className="panels">
          {panels.map((x, i) => (
            <li key={i} className="panel">
              <span className="panel-tag">{i + 1} · {x.tag}</span>
              <div className="panel-art" aria-hidden="true">{x.art}</div>
              <p>{ID ? x.id : x.en}</p>
            </li>
          ))}
        </ol>
        <div className="claim ready">
          <div>
            <h2>{tr('Your turn', 'Giliranmu')}</h2>
            <p className="muted small">{tr('Real stalls, real covenants, real sats. Connect Selene or Paytaca and buy your first stamp.', 'Warung nyata, covenant nyata, sats nyata. Hubungkan Selene atau Paytaca dan beli stamp pertamamu.')}</p>
          </div>
          <a className="primary big" href={location.pathname + location.search} onClick={() => setTimeout(() => location.reload())}>{tr('Start the rally →', 'Mulai rally →')}</a>
        </div>
        <p className="muted small">{tr('Rani and Pak Darto are made up; the stalls are real Jogja favourites and the rally is live.', 'Rani dan Pak Darto tokoh rekaan; warungnya favorit Jogja yang nyata dan rally-nya live.')} <button className="ghost lang" onClick={switchLang}>{ID ? 'EN' : 'ID'}</button></p>
      </main>
    </>
  );
}

export function Banner() {
  return (
    <div className="banner">
      <b>BCH BLAZE 2026 entry</b>
      {SLIDES_URL && <a href={SLIDES_URL} target="_blank" rel="noreferrer">Slides</a>}
      {REPO_URL && <a href={REPO_URL} target="_blank" rel="noreferrer">Code</a>}
      {VOTE_ADDRESS && <span>Vote / donate: <code>{VOTE_ADDRESS}</code></span>}
      <span>Built from scratch during BLAZE (17–22 Nov 2026), no pre-existing code</span>
    </div>
  );
}
