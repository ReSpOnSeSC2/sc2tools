#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "CascLib.h"

namespace fs = std::filesystem;

namespace {

std::string utf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }
    const int size = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
        nullptr, 0, nullptr, nullptr);
    if (size <= 0) {
        throw std::runtime_error("Could not encode an archive path as UTF-8.");
    }
    std::string result(static_cast<std::size_t>(size), '\0');
    if (WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
            result.data(), size, nullptr, nullptr) != size) {
        throw std::runtime_error("Could not encode an archive path as UTF-8.");
    }
    return result;
}

bool is_safe_relative_path(const fs::path& value) {
    if (value.empty() || value.is_absolute() || value.has_root_name() || value.has_root_directory()) {
        return false;
    }
    for (const auto& part : value) {
        if (part == L".." || part == L".") {
            return false;
        }
    }
    return true;
}

std::wstring normalize_archive_path(std::wstring value) {
    std::replace(value.begin(), value.end(), L'/', L'\\');
    while (!value.empty() && value.front() == L'\\') {
        value.erase(value.begin());
    }
    return value;
}

std::string normalize_archive_name(std::string value) {
    std::replace(value.begin(), value.end(), '/', '\\');
    return value;
}

bool ends_with_case_insensitive(const std::string& value, const std::string& suffix) {
    if (suffix.size() > value.size()) {
        return false;
    }
    return _stricmp(value.c_str() + (value.size() - suffix.size()), suffix.c_str()) == 0;
}

bool open_archive_file(
    HANDLE storage,
    const std::string& requested_name,
    HANDLE* file,
    std::string* resolved_name
) {
    if (CascOpenFile(
            storage, requested_name.c_str(), CASC_LOCALE_ALL,
            CASC_OPEN_BY_NAME | CASC_STRICT_DATA_CHECK, file)) {
        *resolved_name = requested_name;
        return true;
    }

    const std::size_t separator = requested_name.find_last_of("\\/");
    const std::string basename = separator == std::string::npos
        ? requested_name
        : requested_name.substr(separator + 1);
    const std::string mask = "*" + basename;
    CASC_FIND_DATA found{};
    HANDLE search = CascFindFirstFile(storage, mask.c_str(), &found, nullptr);
    if (search == INVALID_HANDLE_VALUE) {
        return false;
    }

    std::vector<std::string> candidates;
    do {
        if (found.NameType != CascNameFull || !found.bFileAvailable) {
            continue;
        }
        const std::string candidate = normalize_archive_name(found.szFileName);
        if (ends_with_case_insensitive(candidate, requested_name)) {
            candidates.push_back(candidate);
        }
    } while (CascFindNextFile(search, &found));
    CascFindClose(search);

    std::sort(candidates.begin(), candidates.end());
    candidates.erase(std::unique(candidates.begin(), candidates.end()), candidates.end());
    if (candidates.size() > 1) {
        std::vector<std::string> base_game_candidates;
        std::copy_if(
            candidates.begin(), candidates.end(), std::back_inserter(base_game_candidates),
            [](const std::string& candidate) {
                const std::string normalized = normalize_archive_name(candidate);
                return normalized.find("\\base.sc2assets\\") != std::string::npos
                    && normalized.find("\\novastoryassets.sc2mod\\") == std::string::npos;
            });
        if (base_game_candidates.size() == 1) {
            candidates = std::move(base_game_candidates);
        }
    }
    if (candidates.size() != 1) {
        if (candidates.size() > 1) {
            std::wcerr << L"AMBIGUOUS archive suffix for " << fs::path(requested_name).wstring() << L':';
            for (const auto& candidate : candidates) {
                std::wcerr << L"\n  " << fs::path(candidate).wstring();
            }
            std::wcerr << L'\n';
        }
        return false;
    }

    if (!CascOpenFile(
            storage, candidates.front().c_str(), CASC_LOCALE_ALL,
            CASC_OPEN_BY_NAME | CASC_STRICT_DATA_CHECK, file)) {
        return false;
    }
    *resolved_name = candidates.front();
    return true;
}

bool extract_one(HANDLE storage, const fs::path& output_root, const std::wstring& requested_path) {
    const std::wstring archive_path = normalize_archive_path(requested_path);
    const fs::path relative_path(archive_path);
    if (!is_safe_relative_path(relative_path)) {
        std::wcerr << L"REJECTED unsafe archive path: " << requested_path << L'\n';
        return false;
    }

    const std::string archive_name = utf8(archive_path);
    HANDLE file = nullptr;
    std::string resolved_name;
    if (!open_archive_file(storage, archive_name, &file, &resolved_name)) {
        std::wcerr << L"MISSING " << archive_path << L" (CascLib error " << GetCascError() << L")\n";
        return false;
    }

    if (_stricmp(resolved_name.c_str(), archive_name.c_str()) != 0) {
        std::wcout << L"RESOLVED " << archive_path << L" as " << fs::path(resolved_name).wstring() << L'\n';
    }

    ULONGLONG file_size = 0;
    if (!CascGetFileSize64(file, &file_size)) {
        std::wcerr << L"FAILED size " << archive_path << L" (CascLib error " << GetCascError() << L")\n";
        CascCloseFile(file);
        return false;
    }

    const fs::path target = output_root / relative_path;
    const fs::path temporary = target.wstring() + L".part";
    std::error_code fs_error;
    fs::create_directories(target.parent_path(), fs_error);
    if (fs_error) {
        std::wcerr << L"FAILED mkdir " << target.parent_path().wstring() << L": "
                   << fs_error.message().c_str() << L'\n';
        CascCloseFile(file);
        return false;
    }

    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    if (!output) {
        std::wcerr << L"FAILED open output " << temporary.wstring() << L'\n';
        CascCloseFile(file);
        return false;
    }

    constexpr DWORD buffer_size = 1024 * 1024;
    std::vector<std::uint8_t> buffer(buffer_size);
    ULONGLONG remaining = file_size;
    bool success = true;
    while (remaining > 0) {
        const DWORD requested = static_cast<DWORD>(std::min<ULONGLONG>(remaining, buffer.size()));
        DWORD received = 0;
        if (!CascReadFile(file, buffer.data(), requested, &received) || received != requested) {
            std::wcerr << L"FAILED read " << archive_path << L" (CascLib error " << GetCascError() << L")\n";
            success = false;
            break;
        }
        output.write(reinterpret_cast<const char*>(buffer.data()), received);
        if (!output) {
            std::wcerr << L"FAILED write " << temporary.wstring() << L'\n';
            success = false;
            break;
        }
        remaining -= received;
    }

    output.close();
    CascCloseFile(file);
    if (!success) {
        fs::remove(temporary, fs_error);
        return false;
    }

    if (!MoveFileExW(
            temporary.c_str(), target.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        std::wcerr << L"FAILED finalize " << target.wstring() << L" (Win32 error " << GetLastError() << L")\n";
        fs::remove(temporary, fs_error);
        return false;
    }

    std::wcout << L"EXTRACTED " << archive_path << L" -> " << target.wstring()
               << L" (" << file_size << L" bytes)\n";
    return true;
}

void print_usage() {
    std::wcerr
        << L"Usage: sc2-casc-extract.exe <StarCraft II install root> <output root> <archive path> [...]\n"
        << L"Example: sc2-casc-extract.exe \"C:\\Program Files (x86)\\StarCraft II\" "
           L"models Assets/Textures/Zealot_Diffuse.dds\n";
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    if (argc < 4) {
        print_usage();
        return 2;
    }

    const fs::path storage_root = fs::absolute(argv[1]);
    const fs::path output_root = fs::absolute(argv[2]);
    if (!fs::is_directory(storage_root)) {
        std::wcerr << L"StarCraft II storage root does not exist: " << storage_root.wstring() << L'\n';
        return 2;
    }
    fs::create_directories(output_root);

    HANDLE storage = nullptr;
    if (!CascOpenStorage(storage_root.c_str(), CASC_LOCALE_ALL, &storage)) {
        std::wcerr << L"Could not open StarCraft II CASC storage at " << storage_root.wstring()
                   << L" (CascLib error " << GetCascError() << L")\n";
        return 3;
    }

    int extracted = 0;
    int failed = 0;
    for (int index = 3; index < argc; ++index) {
        if (extract_one(storage, output_root, argv[index])) {
            ++extracted;
        } else {
            ++failed;
        }
    }
    CascCloseStorage(storage);

    std::wcout << L"SUMMARY extracted=" << extracted << L" failed=" << failed << L'\n';
    return failed == 0 ? 0 : 4;
}
