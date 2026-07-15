comment on table bets is
  'Non-authoritative backend bet read model. Canonical accepted financial bet state lives in nines-financial.financial_bets.';

comment on column bets.status is
  'Backend read-model status for UI, performance, and legacy compatibility only; not financial authority.';

comment on column bets.result_status is
  'Backend settlement read-model result only; nines-financial remains canonical for accepted financial bets and settlement postings.';

comment on column bets.metadata is
  'Read-model metadata. Financial command ids/reservation ids are references back to nines-financial, not local authority.';
