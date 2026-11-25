#include "IndexStoreCAPI/indexstore_functions.h"

#define FUNCTIONS(F) \
  F(error_get_description) F(error_dispose) F(format_version) F(version) F(creation_options_create) F(creation_options_dispose) F(creation_options_add_prefix_mapping) \
  F(store_create) F(store_create_with_options) F(store_dispose) F(store_units_apply_f) F(unit_event_notification_get_events_count) F(unit_event_notification_get_event) \
  F(unit_event_notification_is_initial) F(unit_event_get_kind) F(unit_event_get_unit_name) F(store_set_unit_event_handler_f) F(store_start_unit_event_listening) \
  F(store_stop_unit_event_listening) F(store_discard_unit) F(store_discard_record) F(store_purge_stale_data) F(store_get_unit_name_from_output_path) \
  F(store_get_unit_modification_time) F(symbol_get_language) F(symbol_get_kind) F(symbol_get_subkind) F(symbol_get_properties) F(symbol_get_roles) \
  F(symbol_get_related_roles) F(symbol_get_name) F(symbol_get_usr) F(symbol_get_codegen_name) F(symbol_relation_get_roles) F(symbol_relation_get_symbol) \
  F(occurrence_get_symbol) F(occurrence_relations_apply_f) F(occurrence_get_roles) F(occurrence_get_line_col) F(record_reader_create) F(record_reader_dispose) \
  F(record_reader_search_symbols_f) F(record_reader_symbols_apply_f) F(record_reader_occurrences_apply_f) F(record_reader_occurrences_in_line_range_apply_f) \
  F(record_reader_occurrences_of_symbols_apply_f) F(unit_reader_create) F(unit_reader_dispose) F(unit_reader_get_provider_identifier) \
  F(unit_reader_get_provider_version) F(unit_reader_get_modification_time) F(unit_reader_is_system_unit) F(unit_reader_is_module_unit) \
  F(unit_reader_is_debug_compilation) F(unit_reader_has_main_file) F(unit_reader_get_main_file) F(unit_reader_get_module_name) F(unit_reader_get_working_dir) \
  F(unit_reader_get_output_file) F(unit_reader_get_sysroot_path) F(unit_reader_get_target) F(unit_dependency_get_kind) F(unit_dependency_is_system) \
  F(unit_dependency_get_filepath) F(unit_dependency_get_modulename) F(unit_dependency_get_name) F(unit_include_get_source_path) F(unit_include_get_target_path) \
  F(unit_include_get_source_line) F(unit_reader_dependencies_apply_f) F(unit_reader_includes_apply_f)

#define DECLARE(name) extern __typeof__(*((indexstore_functions_t *)0)->name) indexstore_##name;
#define SET(name) f.name = indexstore_##name;
FUNCTIONS(DECLARE)

indexstore_functions_t indexstore_linked_functions(void) {
  indexstore_functions_t f;
  FUNCTIONS(SET)
  return f;
}
