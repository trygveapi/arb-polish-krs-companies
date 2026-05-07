CREATE TABLE IF NOT EXISTS companies (
    krs_number TEXT,
    name TEXT,
    nip TEXT,
    regon TEXT,
    legal_form TEXT,
    registry_type TEXT,
    registration_date TEXT,
    address TEXT,
    status TEXT,
    last_entry_date TEXT,
    PRIMARY KEY (krs_number)
);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_nip ON companies(nip);
CREATE INDEX IF NOT EXISTS idx_companies_regon ON companies(regon);
CREATE INDEX IF NOT EXISTS idx_companies_registry_type ON companies(registry_type);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_last_entry_date ON companies(last_entry_date);
