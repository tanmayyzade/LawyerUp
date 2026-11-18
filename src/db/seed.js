// Demo data: Mumbai is live, other metros are pre-loaded and ready to switch on.
// All people below are FICTIONAL. Run with `npm run db:seed` (wipes app data first).
import { pool, tx } from './pool.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/security.js';

export const DEMO_PASSWORD = 'Demo@1234';

const CITIES = [
  ['mumbai', 'Mumbai', 'Maharashtra', 19.0760, 72.8777, true],
  ['pune', 'Pune', 'Maharashtra', 18.5204, 73.8567, false],
  ['delhi', 'Delhi', 'Delhi', 28.6139, 77.2090, false],
  ['bengaluru', 'Bengaluru', 'Karnataka', 12.9716, 77.5946, false],
  ['hyderabad', 'Hyderabad', 'Telangana', 17.3850, 78.4867, false],
  ['chennai', 'Chennai', 'Tamil Nadu', 13.0827, 80.2707, false],
  ['kolkata', 'Kolkata', 'West Bengal', 22.5726, 88.3639, false],
  ['ahmedabad', 'Ahmedabad', 'Gujarat', 23.0225, 72.5714, false],
];

const MUMBAI_LOCALITIES = [
  ['Andheri East', 19.1155, 72.8721], ['Andheri West', 19.1364, 72.8296], ['Bandra Kurla Complex', 19.0674, 72.8686],
  ['Bandra West', 19.0596, 72.8295], ['Belapur', 19.0235, 73.0400], ['Borivali', 19.2307, 72.8567],
  ['Chembur', 19.0522, 72.9005], ['Churchgate', 18.9322, 72.8264], ['Colaba', 18.9067, 72.8147],
  ['Dadar', 19.0178, 72.8478], ['Fort', 18.9338, 72.8356], ['Ghatkopar', 19.0860, 72.9081],
  ['Goregaon', 19.1663, 72.8526], ['Juhu', 19.1075, 72.8263], ['Kandivali', 19.2047, 72.8526],
  ['Khar', 19.0718, 72.8371], ['Kurla', 19.0726, 72.8845], ['Lower Parel', 18.9953, 72.8302],
  ['Mahim', 19.0410, 72.8400], ['Malad', 19.1874, 72.8484], ['Marine Lines', 18.9447, 72.8236],
  ['Mulund', 19.1726, 72.9425], ['Nariman Point', 18.9256, 72.8242], ['Powai', 19.1176, 72.9060],
  ['Santacruz', 19.0806, 72.8410], ['Sion', 19.0390, 72.8619], ['Thane', 19.2183, 72.9781],
  ['Vashi', 19.0771, 72.9986], ['Vile Parle', 19.0990, 72.8490], ['Worli', 19.0176, 72.8170],
];

const SPECIALIZATIONS = [
  ['family', 'Family law'], ['divorce', 'Divorce & separation'], ['property', 'Property & real estate'],
  ['criminal', 'Criminal defence'], ['civil', 'Civil disputes'], ['corporate', 'Corporate & startups'],
  ['consumer', 'Consumer protection'], ['cheque-bounce', 'Cheque bounce'], ['employment', 'Employment & labour'],
  ['tax', 'Tax & GST'], ['cyber', 'Cyber crime'], ['ip', 'Intellectual property'], ['banking', 'Banking & recovery'],
  ['motor-accident', 'Motor accident claims'], ['wills', 'Wills & succession'], ['rera', 'RERA & builder disputes'],
];

// name, area, years, fee ₹, mins, langs, specs, modes, headline, schedule key
const LAWYERS = [
  ['Aditi Deshmukh', 'Fort', 14, 2500, 30, ['English', 'Hindi', 'Marathi'], ['property', 'rera', 'civil'], ['video', 'phone', 'in_person'], 'Property title, RERA and builder-delay disputes', 'weekday'],
  ['Rohan Mehta', 'Bandra Kurla Complex', 11, 4000, 45, ['English', 'Hindi', 'Gujarati'], ['corporate', 'ip', 'tax'], ['video', 'in_person'], 'Startup structuring, contracts and IP', 'weekday'],
  ['Sana Qureshi', 'Andheri West', 9, 1500, 30, ['English', 'Hindi', 'Urdu'], ['family', 'divorce'], ['video', 'phone', 'in_person'], 'Mutual-consent divorce, custody and maintenance', 'sixday'],
  ['Vikram Iyer', 'Lower Parel', 18, 5000, 60, ['English', 'Tamil', 'Hindi'], ['criminal', 'cyber'], ['video', 'in_person'], 'White-collar and cyber crime defence', 'weekday'],
  ['Priya Nair', 'Powai', 7, 1200, 30, ['English', 'Malayalam', 'Hindi'], ['employment', 'consumer'], ['video', 'phone'], 'Workplace disputes, notice pay and consumer cases', 'evening'],
  ['Kunal Shah', 'Ghatkopar', 12, 1800, 30, ['English', 'Hindi', 'Gujarati', 'Marathi'], ['cheque-bounce', 'banking', 'civil'], ['video', 'phone', 'in_person'], 'Cheque bounce (Sec. 138) and loan recovery', 'sixday'],
  ['Meera Kulkarni', 'Dadar', 22, 3500, 45, ['English', 'Marathi', 'Hindi'], ['wills', 'property', 'family'], ['video', 'phone', 'in_person'], 'Wills, succession certificates and family property', 'weekday'],
  ['Arjun Rao', 'Thane', 6, 800, 20, ['English', 'Hindi', 'Marathi', 'Kannada'], ['motor-accident', 'consumer', 'civil'], ['video', 'phone'], 'Accident claims and insurance disputes', 'evening'],
  ['Farah Khan', 'Kurla', 10, 1400, 30, ['English', 'Hindi', 'Urdu'], ['criminal', 'family'], ['video', 'phone', 'in_person'], 'Bail, FIR and domestic matters', 'sixday'],
  ['Nikhil Joshi', 'Vashi', 8, 1000, 30, ['English', 'Marathi', 'Hindi'], ['rera', 'property', 'consumer'], ['video', 'phone', 'in_person'], 'Flat purchase, society and RERA complaints', 'weekday'],
  ['Ananya Sen', 'Worli', 13, 3000, 30, ['English', 'Bengali', 'Hindi'], ['divorce', 'family'], ['video', 'in_person'], 'Contested divorce and NRI family matters', 'weekday'],
  ['Harsh Agarwal', 'Nariman Point', 16, 4500, 45, ['English', 'Hindi'], ['tax', 'corporate', 'banking'], ['video', 'in_person'], 'GST, income-tax notices and appeals', 'weekday'],
  ['Pooja Patil', 'Borivali', 5, 700, 20, ['English', 'Marathi', 'Hindi'], ['consumer', 'cheque-bounce', 'employment'], ['video', 'phone'], 'Affordable first consultations', 'evening'],
  ['Imran Shaikh', 'Chembur', 15, 2000, 30, ['English', 'Hindi', 'Urdu', 'Marathi'], ['criminal', 'motor-accident'], ['video', 'phone', 'in_person'], 'Sessions court practice and accident claims', 'sixday'],
  ['Kavya Reddy', 'Goregaon', 4, 600, 20, ['English', 'Telugu', 'Hindi'], ['cyber', 'consumer', 'employment'], ['video', 'phone'], 'Online fraud, data misuse and e-commerce complaints', 'evening'],
  ['Siddharth Bhatt', 'Juhu', 19, 4000, 60, ['English', 'Hindi', 'Gujarati'], ['ip', 'corporate'], ['video', 'in_person'], 'Media, entertainment and trademark law', 'weekday'],
  ['Rekha Menon', 'Mulund', 24, 2200, 30, ['English', 'Malayalam', 'Hindi', 'Marathi'], ['wills', 'family', 'property'], ['phone', 'in_person'], 'Senior citizens, wills and gift deeds', 'weekday'],
  ['Aman Gupta', 'Malad', 6, 900, 30, ['English', 'Hindi'], ['employment', 'civil', 'cheque-bounce'], ['video', 'phone'], 'Salary disputes and civil recovery suits', 'sixday'],
  ['Neha Saxena', 'Santacruz', 9, 1600, 30, ['English', 'Hindi', 'Punjabi'], ['divorce', 'family', 'criminal'], ['video', 'phone', 'in_person'], 'Domestic violence and maintenance', 'sixday'],
  ['Devendra Pawar', 'Belapur', 20, 1800, 30, ['Marathi', 'Hindi', 'English'], ['property', 'civil', 'banking'], ['phone', 'in_person'], 'Land records, partition and DRT matters', 'weekday'],
];

const SCHEDULES = {
  weekday: [[1, 5, '10:00', '13:00'], [1, 5, '15:00', '18:00']],
  sixday: [[1, 6, '11:00', '14:00'], [1, 6, '16:00', '19:00']],
  evening: [[1, 5, '18:00', '21:00'], [6, 6, '10:00', '14:00'], [0, 0, '10:00', '13:00']],
};

const REVIEW_TEXT = [
  [5, 'Explained my options clearly and gave practical next steps.'],
  [5, 'Very patient and to the point. Worth the fee.'],
  [4, 'Helpful advice. The call started a few minutes late.'],
  [5, 'Knew the procedure inside out. I finally understood where I stand.'],
  [4, 'Good first consultation, clear about costs for the next stage.'],
  [3, 'Useful, but I wanted more time on documents.'],
  [5, 'Calm and reassuring, answered every question.'],
  [4, 'Solid guidance in simple language.'],
];

const slugify = (s) => s.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

export async function seed({ log = console.log } = {}) {
  if (config.isProd) throw new Error('Refusing to seed demo data in production.');
  const pw = await hashPassword(DEMO_PASSWORD);

  await tx(async (db) => {
    await db.query(`TRUNCATE audit_log, payment_events, reviews, messages, payments, bookings, availability_blocks,
                    availability_rules, lawyer_specializations, lawyer_profiles, specializations, otp_codes, users,
                    localities, cities RESTART IDENTITY CASCADE`);

    for (const c of CITIES) await db.query('INSERT INTO cities (slug, name, state, lat, lng, is_live) VALUES ($1,$2,$3,$4,$5,$6)', c);
    const mumbaiId = (await db.query(`SELECT id FROM cities WHERE slug = 'mumbai'`)).rows[0].id;
    const loc = {};
    for (const [name, lat, lng] of MUMBAI_LOCALITIES) {
      await db.query('INSERT INTO localities (city_id, name, lat, lng) VALUES ($1,$2,$3,$4)', [mumbaiId, name, lat, lng]);
      loc[name] = [lat, lng];
    }
    for (const s of SPECIALIZATIONS) await db.query('INSERT INTO specializations (slug, name) VALUES ($1,$2)', s);

    const addUser = async (role, name, email, phone) => (await db.query(
      `INSERT INTO users (role, name, email, phone, password_hash, phone_verified, kyc_status, kyc_provider, kyc_reference, kyc_verified_at)
       VALUES ($1,$2,$3,$4,$5,true,'verified','sandbox','sbx_seed',now()) RETURNING id`, [role, name, email, phone, pw])).rows[0].id;

    const adminId = await addUser('admin', 'LawyerUp Admin', 'admin@lawyerup.dev', '+919800000000');
    const clientIds = [];
    const clientNames = ['Demo Client', 'Rahul Verma', 'Sneha Pillai', 'Aakash Jain', 'Fatima Ansari', 'Gaurav Kamat'];
    for (const [i, n] of clientNames.entries()) {
      clientIds.push(await addUser('client', n, i === 0 ? 'client@lawyerup.dev' : `${slugify(n)}@example.com`, `+9198000001${String(i).padStart(2, '0')}`));
    }

    const lawyerIds = [];
    for (const [i, L] of LAWYERS.entries()) {
      const [name, area, years, fee, mins, langs, specs, modes, headline, sched] = L;
      const email = i === 0 ? 'lawyer@lawyerup.dev' : `adv.${slugify(name)}@lawyerup.dev`;
      const id = await addUser('lawyer', `Adv. ${name}`, email, `+9198000002${String(i).padStart(2, '0')}`);
      // Small jitter so lawyers in the same area don't sit on one map pin.
      const [lat, lng] = loc[area];
      const jitter = (n) => ((i * 7919 + n) % 100 - 50) / 25000;
      await db.query(
        `INSERT INTO lawyer_profiles (user_id, bar_council, enrollment_number, enrollment_year, verification_status, verified_at, verified_by,
            headline, bio, experience_years, languages, city_id, area, office_address, lat, lng, fee_paise, session_minutes, modes)
         VALUES ($1,'Bar Council of Maharashtra & Goa',$2,$3,'verified',now(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::consult_mode[])`,
        [id, `MAH/${1000 + i * 137}/${new Date().getFullYear() - years}`, new Date().getFullYear() - years, adminId, headline,
          `${name.split(' ')[0]} has practised for ${years} years before courts and tribunals in Mumbai, focusing on ${headline.toLowerCase()}. ` +
          'Consultations cover your situation, your options and realistic timelines and costs for the next step. (Demo profile — fictional.)',
          years, langs, mumbaiId, area, `${area}, Mumbai`, lat + jitter(1), lng + jitter(2), fee * 100, mins, modes]);
      await db.query(`INSERT INTO lawyer_specializations (lawyer_id, specialization_id)
                      SELECT $1, id FROM specializations WHERE slug = ANY($2::text[])`, [id, specs]);
      for (const [from, to, s, e] of SCHEDULES[sched]) {
        for (let d = from; d <= to; d++) {
          await db.query('INSERT INTO availability_rules (lawyer_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [id, d, s, e]);
        }
      }
      lawyerIds.push({ id, fee: fee * 100, mins, mode: modes[0] });
    }

    // Past completed consultations + reviews, so ratings are real aggregates.
    let k = 0;
    for (const [i, L] of lawyerIds.entries()) {
      const n = 2 + ((i * 5) % 6);
      for (let j = 0; j < n; j++) {
        k++;
        const clientId = clientIds[1 + (k % (clientIds.length - 1))];
        const start = new Date(Date.now() - (3 + k) * 86_400_000);
        start.setUTCHours(5 + (k % 6), 30, 0, 0);   // 11:00–16:00 IST
        const end = new Date(start.getTime() + L.mins * 60_000);
        const platform = Math.round(L.fee * config.platformFeeBps / 10_000);
        const { rows: [b] } = await db.query(
          `INSERT INTO bookings (client_id, lawyer_id, starts_at, ends_at, mode, status, fee_paise, platform_fee_paise, total_paise, completed_at, created_at)
           VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$4,$3::timestamptz - interval '2 days') RETURNING id`,
          [clientId, L.id, start, end, L.mode, L.fee, platform, L.fee + platform]);
        await db.query(`INSERT INTO payments (booking_id, provider, provider_order_id, provider_payment_id, amount_paise, status)
                        VALUES ($1,'mock',$2,$3,$4,'captured')`, [b.id, `seed_order_${k}`, `seed_pay_${k}`, L.fee + platform]);
        const [rating, comment] = REVIEW_TEXT[(i + j * 3) % REVIEW_TEXT.length];
        await db.query('INSERT INTO reviews (booking_id, client_id, lawyer_id, rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [b.id, clientId, L.id, rating, comment, end]);
      }
    }
    await db.query(`UPDATE lawyer_profiles lp SET rating_count = s.n, rating_avg = s.avg
                      FROM (SELECT lawyer_id, count(*) n, round(avg(rating)::numeric, 2) avg FROM reviews GROUP BY lawyer_id) s
                     WHERE s.lawyer_id = lp.user_id`);

    // One lawyer awaiting verification, for the admin queue.
    const pendingId = (await db.query(
      `INSERT INTO users (role, name, email, phone, password_hash, phone_verified)
       VALUES ('lawyer','Adv. Tejas Gokhale','pending.lawyer@lawyerup.dev','+919800000399',$1,true) RETURNING id`, [pw])).rows[0].id;
    await db.query(
      `INSERT INTO lawyer_profiles (user_id, bar_council, enrollment_number, enrollment_year, experience_years, languages, city_id, area, lat, lng, fee_paise)
       VALUES ($1,'Bar Council of Maharashtra & Goa','MAH/4821/2019',2019,6,'{English,Marathi}',$2,'Sion',19.039,72.8619,100000)`, [pendingId, mumbaiId]);
    await db.query(`INSERT INTO availability_rules (lawyer_id, weekday, start_time, end_time) VALUES ($1,1,'10:00','13:00')`, [pendingId]);
  });

  log(`Seeded ${LAWYERS.length} verified Mumbai lawyers, 1 pending lawyer, ${CITIES.length} cities, ${MUMBAI_LOCALITIES.length} Mumbai localities.`);
  log(`Demo logins (password ${DEMO_PASSWORD}): client@lawyerup.dev · lawyer@lawyerup.dev · admin@lawyerup.dev`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { migrate } = await import('./migrate.js');
  migrate({ log: () => {} })
    .then(() => seed())
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
