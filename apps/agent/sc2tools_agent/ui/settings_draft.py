"""Track saved form values independently of instant-action settings."""

class SettingsDraft:
    def __init__(self):
        self._fields = []
        self._saved = ()

    def add(self, read, restore):
        self._fields.append((read, restore))

    def commit(self):
        self._saved = tuple(read() for read, _ in self._fields)

    def count(self):
        return sum(read() != saved for (read, _), saved in zip(self._fields, self._saved))

    def revert(self):
        for (read, restore), saved in zip(self._fields, self._saved):
            if read() != saved:
                restore(saved)
